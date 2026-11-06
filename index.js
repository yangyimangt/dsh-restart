/**
 * Host half of `dsh-restart`.
 *
 * The browser half renders the button; this half owns the one privileged
 * operation behind it: relaunching the DeepSeek Harness desktop app.
 *
 * Why the work happens in a detached helper instead of right here:
 *
 * - The Host is a child of the Electron shell (the shell spawns it in its
 *   host-process supervisor), and the shell respawns nothing on its own — it
 *   only reports a fatal error and shows the recovery dialog. So a restart has
 *   to come from outside both processes.
 * - Killing the tree from inside the tree is a race: the helper that is about
 *   to spawn the replacement would be one of the killed processes.
 *
 * So `restart-helper.js` is spawned fully detached, this process answers `202`
 * and the page says goodbye; the helper stops the shell, waits for both
 * processes to be gone, and starts the same executable again.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Route prefix the browser half calls. */
const ROUTE_PREFIX = '/dsh-restart/api'

/** How long the helper may take, end to end, before it gives up. */
const DEFAULT_WAIT_MS = 60_000

/**
 * Reject a cross-site write the way the rest of the Host does: the button is a
 * page's own POST and always carries an `Origin`. A missing `Origin` is not a
 * page's request, but it is also how a non-browser client reaches the Host, so
 * it is allowed — the operation only restarts this machine's own app.
 */
function crossOriginRejected(req) {
  const method = String(req?.method ?? 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null
  const headers = req?.headers ?? {}
  const origin = String(headers.origin ?? '').trim()
  if (origin === '' || origin === 'null') return null
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    return 'Origin header is not a valid URL.'
  }
  // Only http(s) origins can be a page. The desktop shell's own `dsh-app:`
  // document is not forgeable by a website.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const host = String(headers.host ?? '').trim()
  if (host === '') return null
  if (parsed.host === host) return null
  return `Cross-site write refused: Origin ${origin} does not match Host ${host}.`
}

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * The desktop app process this Host belongs to.
 *
 * The Host is spawned by the Electron shell, so its parent is the shell. A
 * plain `dsh web` (no desktop app) has some other parent — which is why the
 * route refuses there instead of killing an unrelated process.
 */
function desktopShellPid() {
  const parent = process.ppid
  if (!Number.isSafeInteger(parent) || parent <= 1) return null
  return parent
}

/** The port this Host serves the page on, so the helper can wait for it to free up. */
function servingPort(webServer) {
  try {
    const origin = new URL(webServer.getOrigin())
    const port = Number(origin.port === '' ? (origin.protocol === 'https:' ? 443 : 80) : origin.port)
    return Number.isSafeInteger(port) && port > 0 ? port : 0
  } catch {
    return 0
  }
}

export const name = 'dsh-restart'
export const inject = ['webServer']

export function apply(ctx) {
  const webServer = ctx.webServer
  const helperPath = fileURLToPath(new URL('./restart-helper.js', import.meta.url))

  ctx.effect(
    () =>
      webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname

          if (pathname === `${ROUTE_PREFIX}/status`) {
            const shellPid = desktopShellPid()
            json(res, 200, {
              ok: true,
              platform: process.platform,
              // The browser half hides the entry where a restart cannot work.
              restartable: process.platform === 'win32' && shellPid !== null,
            })
            return
          }

          if (pathname !== `${ROUTE_PREFIX}/restart`) {
            json(res, 404, { ok: false, error: 'unknown route' })
            return
          }
          if (String(req.method ?? '').toUpperCase() !== 'POST') {
            json(res, 405, { ok: false, error: 'POST required' })
            return
          }
          const crossOrigin = crossOriginRejected(req)
          if (crossOrigin !== null) {
            json(res, 403, { ok: false, error: crossOrigin })
            return
          }

          const shellPid = desktopShellPid()
          if (process.platform !== 'win32' || shellPid === null) {
            json(res, 409, {
              ok: false,
              error:
                'This is not a DeepSeek Harness desktop process, so there is nothing to relaunch.',
            })
            return
          }

          let child
          try {
            child = spawn(
              process.execPath,
              [
                helperPath,
                '--shell-pid',
                String(shellPid),
                '--host-pid',
                String(process.pid),
                '--port',
                String(servingPort(webServer)),
                '--exe',
                process.execPath,
                '--wait',
                String(DEFAULT_WAIT_MS),
              ],
              {
                // The helper must outlive this process, so it cannot share a
                // console or a process group that the kill below would take down.
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
                env: process.env,
              },
            )
            child.on('error', (error) => {
              console.error('[dsh-restart] could not start the helper:', error)
            })
            child.unref()
          } catch (error) {
            json(res, 500, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            })
            return
          }

          // Answer first: the page shows its notice and the app goes away after.
          json(res, 202, { ok: true, helperPid: child.pid ?? null, shellPid })
        },
      }),
    'dsh-restart: relaunch route',
  )
}
