/**
 * Browser half of the Session Delete plugin.
 *
 * One entry in the Session row's "..." menu opens a confirmation dialog; only
 * the dialog's Delete button asks the Host to remove the session. The dialog
 * also reports live/active refusals instead of silently doing nothing.
 */
window.__ModuleLoader__.load({
	id: 'dsh-plugin-session-purge-target',
	factory(require) {
		const React = require('react')
		const h = React.createElement
		// The native menu row and trash glyph are baseline externals available to
		// Module Loader bundles. Keep a hand-styled fallback for a host that
		// cannot resolve the primitive package.
		let primitives
		try {
			primitives = require('@deepseek-ai/dsh-client-ui-primitives')
		} catch {
			primitives = undefined
		}

		const NS = 'sessionPurgeTarget'
		const CHANNEL = '/dsh-plugin-session-purge-target'
		const ENDPOINT = 'delete'

		const en = {
			'menu.deleteSession': 'Delete session',
			'dialog.title': 'Delete session?',
			'dialog.desc': 'Permanently delete “{title}”? This removes the local session log and cannot be undone.',
			'dialog.note': 'Sub-session logs recorded under this session are deleted with it.',
			'dialog.untitled': 'Untitled session',
			'dialog.cancel': 'Cancel',
			'dialog.confirm': 'Delete',
			'dialog.deleting': 'Deleting…',
			'error.live': 'This session is still running. Stop its work before deleting it.',
			'error.active': 'This session still has running work. Stop it before deleting.',
			'error.activeList': 'This session still has running work: {items}. Stop it before deleting.',
			'error.notFound': 'This session no longer exists.',
			'error.unsupported': 'This session store does not support deletion.',
			'error.generic': 'Could not delete the session: {message}',
			'error.genericUnknown': 'Could not delete the session. See the Host log for details.',
			'error.listSeparator': ', ',
			'activity.turn': 'a running turn',
			'activity.subagent': 'a running sub-agent',
			'activity.job': 'a background task',
			'activity.schedule': 'an active reminder',
			'activity.unknown': 'running work',
		}

		const zh = {
			'menu.deleteSession': '删除会话',
			'dialog.title': '删除会话？',
			'dialog.desc': '确定要永久删除「{title}」吗？这会移除本地会话日志，且无法撤销。',
			'dialog.note': '该会话下记录的子会话日志也会一并删除。',
			'dialog.untitled': '未命名会话',
			'dialog.cancel': '取消',
			'dialog.confirm': '删除',
			'dialog.deleting': '正在删除…',
			'error.live': '该会话仍在运行，请先停止其工作再删除。',
			'error.active': '该会话仍有未结束的工作，请先停止后再删除。',
			'error.activeList': '该会话仍有未结束的工作：{items}。请先停止后再删除。',
			'error.notFound': '该会话已不存在。',
			'error.unsupported': '当前会话存储不支持删除。',
			'error.generic': '无法删除会话：{message}',
			'error.genericUnknown': '无法删除会话，请查看 Host 日志了解详情。',
			'error.listSeparator': '、',
			'activity.turn': '进行中的回合',
			'activity.subagent': '运行中的子代理',
			'activity.job': '后台任务',
			'activity.schedule': '活动中的定时提醒',
			'activity.unknown': '进行中的工作',
		}

		const CSS = `
.dsd-menu-item{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:6px 8px;border:none;border-radius:var(--dsw-radius-md);background:transparent;cursor:pointer;font:inherit;font-size:13px;line-height:20px;text-align:left;color:var(--dsw-alias-state-error-primary)}
.dsd-menu-item:hover:not(:disabled),.dsd-menu-item:focus-visible:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);outline:none}
.dsd-menu-item:active:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
.dsd-menu-icon{display:inline-flex;flex:none;width:14px;height:14px;align-items:center;justify-content:center;color:inherit}
.dsd-menu-icon svg{display:block;width:14px;height:14px}
.dsd-menu-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsd-overlay{pointer-events:auto;position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:max(24px,var(--dsh-frame-overlay-top, 24px)) 24px;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur, blur(2px))}
.dsd-dialog{box-sizing:border-box;position:relative;z-index:1;display:flex;flex-direction:column;gap:20px;width:min(400px,100%);max-height:calc(100dvh - 48px);padding:0 0 24px;overflow:hidden;border:0;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);animation:dsd-enter .14s ease-out}
.dsd-dialog:focus{outline:none}
@keyframes dsd-enter{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion: reduce){.dsd-dialog{animation:none}}
.dsd-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:22px 14px 12px 24px}
.dsd-title{margin:0;font-size:16px;line-height:24px;font-weight:500}
.dsd-close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary)}
.dsd-close:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsd-close:disabled{opacity:.5;cursor:default}
.dsd-body{display:flex;flex-direction:column;gap:12px;min-width:0;min-height:0;overflow-y:auto;padding:0 24px;font-size:14px;line-height:22px}
.dsd-desc{margin:0}
.dsd-note{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.dsd-status{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.dsd-error{box-sizing:border-box;padding:8px 10px;border:1px solid color-mix(in srgb,var(--dsw-alias-label-error) 35%,transparent);border-radius:var(--dsw-radius-md);background:color-mix(in srgb,var(--dsw-alias-label-error) 8%,transparent);color:var(--dsw-alias-label-error);font-size:13px;line-height:20px}
.dsd-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:0 24px}
.dsd-btn{height:32px;padding:0 14px;border:.5px solid transparent;border-radius:var(--dsw-radius-md);font:inherit;font-size:13px;line-height:20px;cursor:pointer}
.dsd-btn:disabled{opacity:.5;cursor:default}
.dsd-btn:focus-visible{outline:2px solid var(--dsw-alias-state-error-primary);outline-offset:2px}
.dsd-btn-secondary{border-color:var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary)}
.dsd-btn-secondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsd-btn-danger{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,transparent);background:transparent;color:var(--dsw-alias-state-error-primary)}
.dsd-btn-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}
`

		function createStore(initial) {
			let value = initial
			const listeners = new Set()
			return {
				get: () => value,
				set(next) {
					value = next
					for (const listener of [...listeners]) listener()
				},
				subscribe(listener) {
					listeners.add(listener)
					return () => listeners.delete(listener)
				},
			}
		}

		function TrashIcon(props) {
			return h(
				'svg',
				{
					viewBox: '0 0 16 16',
					width: 14,
					height: 14,
					fill: 'none',
					'aria-hidden': 'true',
					focusable: 'false',
					...props,
				},
				h('path', {
					d: 'M2.6 4.1h10.8M6.2 4.1V3c0-.5.4-.9.9-.9h1.8c.5 0 .9.4.9.9v1.1M4.2 4.1l.6 8.1c.1.9.8 1.6 1.7 1.6h3c.9 0 1.6-.7 1.7-1.6l.6-8.1M6.6 6.8v4M9.4 6.8v4',
					stroke: 'currentColor',
					strokeWidth: 1.2,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
				}),
			)
		}

		function CloseIcon() {
			return h(
				'svg',
				{ viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
				h('path', { d: 'M4 4l8 8M12 4l-8 8', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
			)
		}

		function DeleteSessionMenuItem(props) {
			const { sessionId, displayTitle, useMenuOpenState, openDelete, t } = props
			const menuState = typeof useMenuOpenState === 'function' ? useMenuOpenState() : undefined
			const closeMenu = Array.isArray(menuState) ? menuState[1] : undefined
			const onSelect = () => {
				if (typeof closeMenu === 'function') closeMenu(false)
				openDelete(sessionId, typeof displayTitle === 'string' ? displayTitle : '')
			}
			const NativeMenuItem = primitives?.MenuItemButton
			const NativeTrashIcon = primitives?.IconTrashOutlineRegular
			if (typeof NativeMenuItem === 'function' && typeof NativeTrashIcon === 'function') {
				return h(
					NativeMenuItem,
					{
						danger: true,
						icon: h(NativeTrashIcon, {}),
						onSelect,
					},
					t('menu.deleteSession'),
				)
			}
			return h(
				'button',
				{
					type: 'button',
					role: 'menuitem',
					className: 'dsd-menu-item',
					onClick: onSelect,
				},
				h(TrashIcon, { className: 'dsd-menu-icon' }),
				h('span', { className: 'dsd-menu-label' }, t('menu.deleteSession')),
			)
		}

		function DeleteSessionDialog(props) {
			const { usePending, closeDelete, confirmDelete, t } = props
			const request = usePending()
			const cancelRef = React.useRef(null)
			const dialogRef = React.useRef(null)
			const open = request !== null
			const phase = request === null ? 'idle' : request.phase

			React.useEffect(() => {
				if (!open) return undefined
				const previous = typeof document === 'undefined' ? null : document.activeElement
				const timer = window.setTimeout(() => {
					if (phase === 'confirm' && cancelRef.current !== null) cancelRef.current.focus()
					else if (dialogRef.current !== null) dialogRef.current.focus()
				}, 0)
				const onKeyDown = (event) => {
					if (event.key !== 'Escape') return
					event.preventDefault()
					event.stopPropagation()
					closeDelete()
				}
				window.addEventListener('keydown', onKeyDown, true)
				return () => {
					window.clearTimeout(timer)
					window.removeEventListener('keydown', onKeyDown, true)
					if (previous instanceof HTMLElement) previous.focus()
				}
			}, [open, phase, closeDelete])

			if (!open) return null

			const deleting = phase === 'deleting'
			const errorText = phase === 'error' ? describeError(t, request.error) : ''
			const title = typeof request.title === 'string' && request.title.trim().length > 0
				? request.title
				: t('dialog.untitled')

			const trapFocus = (event) => {
				if (event.key !== 'Tab' || dialogRef.current === null) return
				const focusable = dialogRef.current.querySelectorAll(
					'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
				)
				if (focusable.length === 0) return
				const first = focusable[0]
				const last = focusable[focusable.length - 1]
				if (event.shiftKey && document.activeElement === first) {
					event.preventDefault()
					last.focus()
				} else if (!event.shiftKey && document.activeElement === last) {
					event.preventDefault()
					first.focus()
				}
			}

			return h(
				'div',
				{
					className: 'dsd-overlay',
					onMouseDown: (event) => {
						if (event.target === event.currentTarget) closeDelete()
					},
				},
				h(
					'div',
					{
						className: 'dsd-dialog',
						ref: dialogRef,
						role: 'dialog',
						'aria-modal': 'true',
						'aria-labelledby': 'dsd-title',
						'aria-describedby': 'dsd-desc',
						tabIndex: -1,
						onKeyDown: trapFocus,
					},
					h(
						'div',
						{ className: 'dsd-header' },
						h('h2', { className: 'dsd-title', id: 'dsd-title' }, t('dialog.title')),
						h(
							'button',
							{
								type: 'button',
								className: 'dsd-close',
								onClick: closeDelete,
								disabled: deleting,
								'aria-label': t('dialog.cancel'),
							},
							h(CloseIcon),
						),
					),
					h(
						'div',
						{ className: 'dsd-body' },
						h('p', { className: 'dsd-desc', id: 'dsd-desc' }, t('dialog.desc', { title })),
						h('p', { className: 'dsd-note' }, t('dialog.note')),
						deleting ? h('div', { className: 'dsd-status', role: 'status' }, t('dialog.deleting')) : null,
						errorText.length > 0 ? h('div', { className: 'dsd-error', role: 'alert' }, errorText) : null,
					),
					h(
						'div',
						{ className: 'dsd-footer' },
						h(
							'button',
							{ ref: cancelRef, type: 'button', className: 'dsd-btn dsd-btn-secondary', onClick: closeDelete, disabled: deleting },
							t('dialog.cancel'),
						),
						h(
							'button',
							{ type: 'button', className: 'dsd-btn dsd-btn-danger', onClick: confirmDelete, disabled: deleting },
							deleting ? t('dialog.deleting') : t('dialog.confirm'),
						),
					),
				),
			)
		}

		function activityLabel(t, entry) {
			const kind = typeof entry?.kind === 'string' ? entry.kind : ''
			const key = {
				turn: 'activity.turn',
				subagent: 'activity.subagent',
				job: 'activity.job',
				schedule: 'activity.schedule',
			}[kind]
			const label = key === undefined ? (kind.length > 0 ? kind : t('activity.unknown')) : t(key)
			const name = typeof entry?.name === 'string' ? entry.name.trim() : ''
			return name.length > 0 ? `${label} “${name}”` : label
		}

		function describeError(t, error) {
			if (error === null || typeof error !== 'object') return t('error.genericUnknown')
			const code = typeof error.code === 'string' ? error.code : ''
			if (code === 'session-live') return t('error.live')
			if (code === 'session-active') {
				const activity = Array.isArray(error.details?.activity) ? error.details.activity : []
				const items = activity.map((entry) => activityLabel(t, entry)).filter((item) => item.length > 0)
				if (items.length === 0) return t('error.active')
				return t('error.activeList', { items: items.join(t('error.listSeparator')) })
			}
			if (code === 'session-not-found') return t('error.notFound')
			if (code === 'unsupported-backend' || code === 'store-unavailable') return t('error.unsupported')
			const message = typeof error.message === 'string' ? error.message : ''
			return message.length > 0 ? t('error.generic', { message }) : t('error.genericUnknown')
		}

		function apply(ctx) {
			const pending = createStore(null)
			const usePending = () => React.useSyncExternalStore(pending.subscribe, pending.get, pending.get)

			const openDelete = (sessionId, title) => {
				if (typeof sessionId !== 'string' || sessionId.length === 0) return
				pending.set({ sessionId, title, phase: 'confirm', error: null })
			}
			const closeDelete = () => {
				const current = pending.get()
				if (current !== null && current.phase === 'deleting') return
				pending.set(null)
			}
			const confirmDelete = async () => {
				const request = pending.get()
				if (request === null || request.phase === 'deleting') return
				pending.set({ ...request, phase: 'deleting', error: null })
				let result
				try {
					result = await ctx.connection.rpc.call(CHANNEL, ENDPOINT, { sessionId: request.sessionId })
				} catch (error) {
					pending.set({
						...request,
						phase: 'error',
						error: { code: 'transport', message: error instanceof Error ? error.message : String(error), details: {} },
					})
					return
				}
				if (result !== null && typeof result === 'object' && result.ok === true) {
					pending.set(null)
					return
				}
				const failure = result !== null && typeof result === 'object' && result.error !== null && typeof result.error === 'object'
					? result.error
					: { code: 'unknown', message: 'unknown failure', details: {} }
				pending.set({ ...request, phase: 'error', error: failure })
			}

			ctx.effect(() => {
				const style = document.createElement('style')
				style.dataset.dshPlugin = 'dsh-plugin-session-purge-target'
				style.textContent = CSS
				document.head.append(style)
				return () => style.remove()
			}, 'session-purge-target: styles')

			ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'session-purge-target: dictionaries')

			ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
				name: 'sidebar.workspaces.session.menu.item',
				id: 'session-purge-target',
				order: 500,
				locale: NS,
				inject: () => ({ openDelete }),
			}, DeleteSessionMenuItem))

			ctx.slots.inject('shell.overlay', () => ctx.slots.register({
				name: 'shell.overlay',
				id: 'session-purge-target-confirm',
				locale: NS,
				inject: () => ({ usePending, closeDelete, confirmDelete }),
			}, DeleteSessionDialog))
		}

		return { inject: ['slots', 'locale', 'connection'], apply }
	},
})
