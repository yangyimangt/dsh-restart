window.__ModuleLoader__.load({
  id: 'dsh-restart',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-restart'
    /** The panel list's More menu — the row lands beside "Browse other plugins". */
    const MENU_SLOT = 'sidebar.panellist.actions'
    /** The frame-wide floating layer, where the confirmation lives. */
    const OVERLAY_SLOT = 'shell.overlay'
    const API = '/dsh-restart/api'

    const ZH = {
      action: '重启应用',
      title: '重启 DeepSeek Harness',
      confirmTitle: '重启 DeepSeek Harness？',
      confirmBody: '正在运行的任务会中断，当前页面会关闭；重启完成后需要重新打开会话。',
      confirm: '立即重启',
      cancel: '取消',
      restarting: '正在重启…',
      restartingBody: '应用关闭后会自行重新打开。若没有自动回来，请手动启动 DeepSeek Harness。',
      failed: '重启没有开始',
    }
    const EN = {
      action: 'Restart app',
      title: 'Restart DeepSeek Harness',
      confirmTitle: 'Restart DeepSeek Harness?',
      confirmBody:
        'Running tasks will be interrupted and this page will close. Reopen the session once the app is back.',
      confirm: 'Restart now',
      cancel: 'Cancel',
      restarting: 'Restarting…',
      restartingBody:
        'The app reopens on its own after it closes. Start DeepSeek Harness manually if it does not come back.',
      failed: 'The restart did not start',
    }

    // The More menu's rows are the host's `MenuItemButton`: same geometry,
    // same hover, same tokens. Copied rather than required — a plain-JS plugin
    // has no type check against ui-primitives and a renamed export would blank
    // the row. Only `--dsw-*` tokens are referenced, so a theme change still
    // reaches this button.
    const STYLE = `
.dsh-restart-item {
  display: flex; align-items: center; gap: 6px;
  width: 100%; min-height: 34px; padding: 6px 8px;
  border: none; border-radius: var(--dsw-radius-md);
  background: transparent; cursor: pointer;
  font: inherit; font-size: 13px; line-height: 20px;
  color: var(--dsw-alias-label-primary); text-align: left;
}
.dsh-restart-item:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-restart-item:focus-visible:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover); outline: none;
}
.dsh-restart-item:disabled { opacity: 0.4; cursor: not-allowed; }
.dsh-restart-item-icon { flex: none; width: 12px; height: 12px; display: inline-flex; }
.dsh-restart-item-icon svg { width: 12px; height: 12px; }
.dsh-restart-item-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.dsh-restart-overlay {
  position: fixed; inset: 0; z-index: 1200;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.42);
  pointer-events: auto;
}
.dsh-restart-dialog {
  width: min(440px, calc(100vw - 48px));
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-primary);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.4);
  padding: 18px 20px 16px;
  font: inherit;
}
.dsh-restart-dialog h2 { margin: 0 0 8px; font-size: 15px; font-weight: 600; }
.dsh-restart-dialog p { margin: 0; font-size: 13px; line-height: 1.7; color: var(--dsw-alias-label-secondary); }
.dsh-restart-error { color: var(--dsw-alias-state-error-primary) !important; margin-top: 8px !important; }
.dsh-restart-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
.dsh-restart-actions button {
  font: inherit; font-size: 13px; line-height: 18px;
  padding: 6px 14px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1);
  background: transparent; color: var(--dsw-alias-label-primary);
}
.dsh-restart-actions button:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-1); }
.dsh-restart-actions button.primary {
  border-color: var(--dsw-alias-state-error-primary);
  background: var(--dsw-alias-state-error-primary);
  color: #fff;
}
.dsh-restart-actions button.primary:hover:not(:disabled) { filter: brightness(1.06); }
.dsh-restart-actions button:disabled { opacity: 0.6; cursor: default; }
`

    /**
     * The menu row and the confirmation are two slot entries, so they cannot
     * share React state. This tiny module-level store is the bridge: the row
     * opens it, the overlay renders it. One entry each, so no keys are needed.
     */
    const dialog = {
      snapshot: { open: false, busy: false, error: '' },
      listeners: new Set(),
      update(patch) {
        dialog.snapshot = { ...dialog.snapshot, ...patch }
        for (const listener of dialog.listeners) listener()
      },
      subscribe(listener) {
        dialog.listeners.add(listener)
        return () => dialog.listeners.delete(listener)
      },
      getSnapshot() {
        return dialog.snapshot
      },
    }

    function RestartIcon() {
      // A circular arrow: the universal "restart" mark, drawn here so nothing
      // depends on another package's artwork.
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M13.2 6.6A5.4 5.4 0 1 0 13.4 9.6' }),
        h('path', { d: 'M13.4 2.8v3.9H9.5' }),
      )
    }

    /** One row in the panel list's More menu. */
    function RestartMenuItem({ t, onDismiss }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          className: 'dsh-restart-item',
          title: t('title'),
          onClick: () => {
            // The menu owns its own open state; close it before raising the
            // dialog, otherwise the menu's outside-pointerdown closes both.
            onDismiss?.()
            dialog.update({ open: true, busy: false, error: '' })
          },
        },
        h('span', { className: 'dsh-restart-item-icon', 'aria-hidden': 'true' }, h(RestartIcon)),
        h('span', { className: 'dsh-restart-item-label' }, t('action')),
      )
    }

    /** The confirmation, mounted once in the frame's overlay layer. */
    function RestartDialog({ t }) {
      const state = React.useSyncExternalStore(dialog.subscribe, dialog.getSnapshot)
      const confirmRef = React.useRef(null)

      React.useEffect(() => {
        if (!state.open || state.busy) return
        confirmRef.current?.focus()
      }, [state.open, state.busy])

      React.useEffect(() => {
        if (!state.open) return
        const onKey = (event) => {
          if (event.key !== 'Escape' || dialog.getSnapshot().busy) return
          event.preventDefault()
          dialog.update({ open: false, error: '' })
        }
        document.addEventListener('keydown', onKey, true)
        return () => document.removeEventListener('keydown', onKey, true)
      }, [state.open])

      if (!state.open) return null

      const start = async () => {
        dialog.update({ busy: true, error: '' })
        try {
          const response = await fetch(`${API}/restart`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          const body = await response.json().catch(() => null)
          if (!response.ok || body?.ok !== true) {
            dialog.update({
              busy: false,
              error: `${t('failed')}: ${body?.error ?? `HTTP ${response.status}`}`,
            })
          }
          // On success the app is about to disappear; the dialog stays on the
          // "restarting" text until the page goes away with it.
        } catch (failure) {
          dialog.update({
            busy: false,
            error: `${t('failed')}: ${failure instanceof Error ? failure.message : String(failure)}`,
          })
        }
      }

      return h(
        'div',
        {
          className: 'dsh-restart-overlay',
          role: 'presentation',
          onClick: (event) => {
            if (event.target === event.currentTarget && !state.busy) {
              dialog.update({ open: false, error: '' })
            }
          },
        },
        h(
          'div',
          {
            className: 'dsh-restart-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'dsh-restart-dialog-title',
          },
          h(
            'h2',
            { id: 'dsh-restart-dialog-title' },
            state.busy ? t('restarting') : t('confirmTitle'),
          ),
          h('p', null, state.busy ? t('restartingBody') : t('confirmBody')),
          state.error ? h('p', { className: 'dsh-restart-error' }, state.error) : null,
          state.busy
            ? null
            : h(
                'div',
                { className: 'dsh-restart-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: () => dialog.update({ open: false, error: '' }),
                  },
                  t('cancel'),
                ),
                h(
                  'button',
                  { type: 'button', className: 'primary', ref: confirmRef, onClick: start },
                  t('confirm'),
                ),
              ),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'dsh-restart: locale')
        const t = ctx.locale.bind(NS)

        ctx.effect(
          () =>
            ctx.slots.inject(MENU_SLOT, () =>
              ctx.slots.register(
                {
                  name: MENU_SLOT,
                  id: NS,
                  // After the shipped rows ("Browse other plugins" / "Create
                  // your plugin"), so this reads as one more action.
                  order: 200,
                  label: () => t('action'),
                  locale: NS,
                  inject: () => ({}),
                },
                (props) => h(RestartMenuItem, { t, onDismiss: props?.onDismiss }),
              ),
            ),
          'dsh-restart: panel More menu row',
        )

        ctx.effect(
          () =>
            ctx.slots.inject(OVERLAY_SLOT, () =>
              ctx.slots.register(
                {
                  name: OVERLAY_SLOT,
                  id: NS,
                  order: 100,
                  locale: NS,
                  inject: () => ({}),
                },
                () => h(React.Fragment, null, h('style', null, STYLE), h(RestartDialog, { t })),
              ),
            ),
          'dsh-restart: confirmation overlay',
        )
      },
    }
  },
})
