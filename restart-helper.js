/**
 * Detached relaunch helper for `dsh-restart`.
 *
 * Runs in its own process, started by the Host route, and is the only part of
 * the restart that survives the app it is restarting. Sequence:
 *
 * 1. stop the Electron shell (the app's main process),
 * 2. let the Host inside it shut down gracefully, forcing it only if it lingers,
 * 3. wait until the Host's listening port is free,
 * 4. start the same executable again, as an app rather than as Node.
 *
 * Every wait is bounded and every outcome is appended to
 * `%TEMP%/dsh-restart.log`: a restart that fails leaves no console behind, so
 * that file is the only account of what happened.
 *
 * Deliberately plain Node with `node:` builtins only — it is started through
 * `process.execPath`, which on a packaged Desktop install is the Electron
 * binary running as Node.
 */

import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LOG_PATH = join(tmpdir(), 'dsh-restart.log')

function note(line) {
  try {
    appendFileSync(LOG_PATH, `[dsh-restart ${new Date().toISOString()}] ${line}\n`)
  } catch {
    // A helper that cannot log still has to restart the app.
  }
}

function parseArgs(argv) {
  const out = { shellPid: 0, hostPid: 0, port: 0, exe: '', waitMs: 60_000 }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--shell-pid') out.shellPid = Number(argv[++i])
    else if (flag === '--host-pid') out.hostPid = Number(argv[++i])
    else if (flag === '--port') out.port = Number(argv[++i])
    else if (flag === '--exe') out.exe = String(argv[++i] ?? '')
    else if (flag === '--wait') out.waitMs = Number(argv[++i])
  }
  return out
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Whether `pid` still names a live process. */
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means it exists and belongs to someone else.
    return error?.code === 'EPERM'
  }
}

async function waitUntilGone(pid, budgetMs) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await sleep(200)
  }
  return !alive(pid)
}

/** Nothing accepting connections on the port means the old Host released it. */
function portFree(port) {
  return new Promise((resolve) => {
    const probe = connect({ host: '127.0.0.1', port })
    const done = (free) => {
      probe.destroy()
      resolve(free)
    }
    probe.once('connect', () => done(false))
    probe.once('error', () => done(true))
    setTimeout(() => done(false), 800)
  })
}

async function waitForPortFree(port, budgetMs) {
  if (!Number.isSafeInteger(port) || port <= 0) return true
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (await portFree(port)) return true
    await sleep(250)
  }
  return portFree(port)
}

/**
 * Force one process to exit. `/F` forces it and `/T` is deliberately absent:
 * this helper is itself a descendant of the Host, so a tree kill would take the
 * helper down with the thing it is restarting.
 */
function forceKill(pid) {
  return new Promise((resolve) => {
    const killer = spawn('taskkill', ['/PID', String(pid), '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    killer.once('error', (error) => {
      note(`taskkill failed to start: ${error instanceof Error ? error.message : String(error)}`)
      resolve(false)
    })
    killer.once('exit', (code) => resolve(code === 0))
  })
}

const options = parseArgs(process.argv.slice(2))
const totalBudget =
  Number.isFinite(options.waitMs) && options.waitMs > 0 ? options.waitMs : 60_000

if (options.exe === '' || !Number.isSafeInteger(options.shellPid) || options.shellPid <= 1) {
  note(`refusing: exe=${JSON.stringify(options.exe)} shellPid=${String(options.shellPid)}`)
  process.exit(2)
}

note(
  `helper up (pid ${String(process.pid)}): shell=${String(options.shellPid)} ` +
    `host=${String(options.hostPid)} port=${String(options.port)}`,
)

if (alive(options.shellPid)) {
  note(`stopping the shell (taskkill ok=${String(await forceKill(options.shellPid))})`)
}

if (!(await waitUntilGone(options.shellPid, 20_000))) {
  note('the shell is still running; not starting a replacement')
  process.exit(3)
}
note('shell is gone')

// The Host usually stops on its own: its IPC channel to the shell disconnects
// and its `disconnect` handler runs the graceful shutdown. It drains running
// work first, so give it a real window — but a Host that never stops would
// otherwise block the restart forever.
if (!(await waitUntilGone(options.hostPid, 15_000))) {
  note('the Host did not stop on its own; forcing it')
  note(`forcing the Host (taskkill ok=${String(await forceKill(options.hostPid))})`)
  if (!(await waitUntilGone(options.hostPid, 10_000))) {
    note('the Host is still running; not starting a replacement')
    process.exit(4)
  }
}
note('Host is gone')

if (!(await waitForPortFree(options.port, 15_000))) {
  note(`port ${String(options.port)} is still in use; starting anyway`)
} else {
  note(`port ${String(options.port)} is free`)
}

// A released socket can stay in TIME_WAIT for a moment on Windows.
await sleep(500)

// The Host runs with ELECTRON_RUN_AS_NODE=1 (it is the Electron binary acting
// as Node). Inheriting that would start the replacement as a Node script
// instead of the app, so it is removed here.
const launchEnv = { ...process.env }
delete launchEnv.ELECTRON_RUN_AS_NODE

note(`starting ${options.exe}`)
const replacement = spawn(options.exe, [], {
  detached: true,
  stdio: 'ignore',
  // A visible window is the point: this is the app coming back.
  windowsHide: false,
  env: launchEnv,
})
replacement.once('error', (error) => {
  note(`could not start the replacement: ${error instanceof Error ? error.message : String(error)}`)
})
replacement.unref()
note(`replacement started (pid ${String(replacement.pid ?? '?')})`)
