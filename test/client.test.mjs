import assert from 'node:assert/strict'

let definition
globalThis.window = {
	__ModuleLoader__: {
		load(value) {
			definition = value
		},
	},
	setTimeout,
	clearTimeout,
	addEventListener() {},
	removeEventListener() {},
}
globalThis.document = {
	head: { append() {} },
	activeElement: null,
	createElement() {
		return { dataset: {}, textContent: '', remove() {} }
	},
}

await import(`${new URL('../client.js', import.meta.url).href}?test=1`)

assert.ok(definition, 'client.js must register a Module Loader definition')
assert.equal(definition.id, 'dsh-plugin-session-purge-target')

const React = {
	createElement(type, props, ...children) {
		const normalized = children.length === 0
			? (props ?? {})
			: { ...(props ?? {}), children: children.length === 1 ? children[0] : children }
		return { type, props: normalized, children }
	},
	useRef(value) {
		return { current: value }
	},
	useEffect() {},
	useSyncExternalStore(_subscribe, getSnapshot) {
		return getSnapshot()
	},
}

const plugin = definition.factory((specifier) => {
	if (specifier === 'react') return React
	throw new Error(`unexpected require(${JSON.stringify(specifier)})`)
})
assert.deepEqual(plugin.inject, ['slots', 'locale', 'connection'])
assert.equal(typeof plugin.apply, 'function')

const registrations = []
const effects = []
let dictionaries = null
let rpcCalls = 0
let nextResult = { ok: true, value: { removedSessionIds: ['session-x'] } }
const ctx = {
	effect(fn, label) {
		effects.push(label)
		return fn()
	},
	locale: {
		register(namespace, value) {
			dictionaries = { namespace, value }
			return () => {}
		},
	},
	slots: {
		inject(_name, register) {
			register()
		},
		register(options, component) {
			registrations.push({ options, component })
			return () => {}
		},
	},
	connection: {
		rpc: {
			async call(channel, endpoint, payload) {
				rpcCalls += 1
				assert.equal(channel, '/dsh-plugin-session-purge-target')
				assert.equal(endpoint, 'delete')
				assert.equal(payload.sessionId, 'session-x')
				if (nextResult instanceof Error) throw nextResult
				return nextResult
			},
		},
	},
}

plugin.apply(ctx)

const menu = registrations.find((entry) => entry.options.name === 'sidebar.workspaces.session.menu.item')
const overlay = registrations.find((entry) => entry.options.name === 'shell.overlay')
assert.ok(menu, 'menu item must be registered')
assert.equal(menu.options.id, 'session-purge-target')
assert.equal(menu.options.order, 500)
assert.equal(menu.options.locale, 'sessionPurgeTarget')
assert.ok(overlay, 'confirmation dialog must be registered in shell.overlay')
assert.equal(overlay.options.id, 'session-purge-target-confirm')
assert.equal(dictionaries.namespace, 'sessionPurgeTarget')
assert.equal(dictionaries.value.en['menu.deleteSession'], 'Delete session')
assert.equal(dictionaries.value.zh['menu.deleteSession'], '删除会话')
assert.ok(dictionaries.value.zh['dialog.desc'].includes('永久删除'))
assert.ok(effects.some((label) => label.includes('styles')))

const open = menu.options.inject()
const dialog = overlay.options.inject()
assert.equal(typeof open.openDelete, 'function')
assert.equal(typeof dialog.confirmDelete, 'function')
assert.equal(dialog.usePending(), null)

let menuClosed = 0
open.openDelete('session-x', 'Deleting demo')
const menuTree = menu.component({
	sessionId: 'session-x',
	displayTitle: 'Deleting demo',
	useMenuOpenState: () => [false, (value) => { menuClosed += value === false ? 1 : 0 }],
	openDelete: open.openDelete,
	t: (key) => key,
})
assert.equal(menuTree.type, 'button')
const button = menuTree
assert.equal(button.props.role, 'menuitem')
assert.equal(button.props.className, 'dsd-menu-item')
const label = button.children[1]
assert.equal(label.children[0], 'menu.deleteSession')
button.props.onClick()
assert.equal(menuClosed, 1)
assert.equal(dialog.usePending().phase, 'confirm')
assert.equal(dialog.usePending().title, 'Deleting demo')

let dialogTree = overlay.component({ ...dialog, t: (key) => key })
assert.equal(dialogTree.type, 'div')
assert.equal(dialogTree.props.className, 'dsd-overlay')
const panel = dialogTree.children[0]
assert.equal(panel.props.role, 'dialog')
assert.equal(panel.props['aria-modal'], 'true')

dialog.closeDelete()
assert.equal(dialog.usePending(), null)
assert.equal(rpcCalls, 0)
open.openDelete('session-x', 'Deleting demo')

nextResult = { ok: false, error: { code: 'session-active', message: 'busy', details: { activity: [{ kind: 'job', name: 'build' }] } } }
await dialog.confirmDelete()
assert.equal(dialog.usePending().phase, 'error')
assert.equal(dialog.usePending().error.code, 'session-active')
dialogTree = overlay.component({ ...dialog, t: (key) => key })
const errorBox = findNode(dialogTree, (node) => node.props?.role === 'alert')
assert.ok(errorBox, 'error state must render an alert')
assert.equal(errorBox.children[0], 'error.activeList')

nextResult = new Error('network down')
await dialog.confirmDelete()
assert.equal(dialog.usePending().phase, 'error')
assert.equal(dialog.usePending().error.code, 'transport')

nextResult = { ok: true, value: { removedSessionIds: ['session-x'] } }
await dialog.confirmDelete()
assert.equal(dialog.usePending(), null)

nextResult = { ok: false, error: { code: 'session-not-found', message: 'gone', details: {} } }
open.openDelete('session-x', 'Already gone')
await dialog.confirmDelete()
assert.equal(dialog.usePending().phase, 'error')
assert.equal(dialog.usePending().error.code, 'session-not-found')

let release
nextResult = new Promise((resolve) => {
	release = () => resolve({ ok: true, value: {} })
})
open.openDelete('session-x', 'Deleting demo')
const pendingDelete = dialog.confirmDelete()
dialog.closeDelete()
assert.equal(dialog.usePending().phase, 'deleting')
release()
await pendingDelete
assert.equal(dialog.usePending(), null)

const NativeMenuItemButton = () => null
const NativeTrashIcon = () => null
const nativePlugin = definition.factory((specifier) => {
	if (specifier === 'react') return React
	if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
		return { MenuItemButton: NativeMenuItemButton, IconTrashOutlineRegular: NativeTrashIcon }
	}
	throw new Error(`unexpected require(${JSON.stringify(specifier)})`)
})
const nativeRegistrations = []
nativePlugin.apply({
	effect(fn) {
		return fn()
	},
	locale: { register() { return () => {} } },
	slots: {
		inject(_name, register) {
			register()
		},
		register(options, component) {
			nativeRegistrations.push({ options, component })
			return () => {}
		},
	},
	connection: { rpc: { async call() { return { ok: true, value: {} } } } },
})
const nativeMenu = nativeRegistrations.find((entry) => entry.options.name === 'sidebar.workspaces.session.menu.item')
let nativeClosed = 0
const nativeOpened = []
const nativeTree = nativeMenu.component({
	sessionId: 'session-native',
	displayTitle: 'Native delete',
	useMenuOpenState: () => [false, (value) => { if (value === false) nativeClosed += 1 }],
	openDelete: (id, title) => nativeOpened.push({ id, title }),
	t: (key) => key,
})
assert.equal(nativeTree.type, NativeMenuItemButton)
assert.equal(nativeTree.props.danger, true)
assert.equal(nativeTree.props.icon.type, NativeTrashIcon)
assert.equal(nativeTree.props.children, 'menu.deleteSession')
nativeTree.props.onSelect()
assert.equal(nativeClosed, 1)
assert.deepEqual(nativeOpened, [{ id: 'session-native', title: 'Native delete' }])

function findNode(node, predicate) {
	if (node === null || typeof node !== 'object') return undefined
	if (predicate(node)) return node
	for (const child of node.children ?? []) {
		const found = findNode(child, predicate)
		if (found !== undefined) return found
	}
	return undefined
}

console.log('client structure: 1 passed, 0 failed')
