import assert from 'node:assert/strict'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { performDelete, encodeSegment } from '../index.js'

const TMP = new URL('./.tmp/', import.meta.url)
const root = new URL('./.tmp/sessions/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

let passed = 0
let failed = 0

async function test(name, fn) {
	try {
		await rm(TMP, { recursive: true, force: true })
		await mkdir(root, { recursive: true })
		await fn()
		passed += 1
		console.log(`ok   ${name}`)
	} catch (error) {
		failed += 1
		console.error(`FAIL ${name}`)
		console.error(error)
	}
}

function makeContext(entries, { activity = [], running = new Set(), resident = new Set(), archiveError } = {}) {
	const archived = []
	const unarchived = []
	const detached = []
	const events = []
	const ctx = {
		sessionPersistence: {
			root,
			async stat(id) {
				const entry = entries.find((item) => item.header.id === id)
				if (entry === undefined) return undefined
				return { header: entry.header, revision: 'test', sizeBytes: entry.bytes }
			},
			async list() {
				return entries.map((entry) => ({ header: entry.header, revision: 'test', sizeBytes: entry.bytes }))
			},
		},
		agents: {
			get: (id) => (running.has(id)
				? { id, status: 'running' }
				: resident.has(id) ? { id, status: 'idle' } : undefined),
		},
		emit(name, id) {
			events.push([name, id])
		},
		workspaceRegistry: {
			archivedSessionIds: archived,
			list() {
				return [{
					async detachSession(id) {
						detached.push(id)
					},
				}]
			},
			async archiveSession(id) {
				if (archiveError !== undefined) throw archiveError
				if (!archived.includes(id)) archived.push(id)
			},
			async unarchiveSession(id) {
				const index = archived.indexOf(id)
				if (index >= 0) archived.splice(index, 1)
				unarchived.push(id)
			},
		},
		async waterfall(name, arg, fallback) {
			assert.equal(name, 'workspace/session-activity')
			return activity
		},
	}
	return { ctx, archived, unarchived, detached, events }
}

async function writeSession(header, bytes = 32) {
	const project = header.cwd === undefined ? '_no-cwd' : '--test-project--'
	const dir = join(root, project, encodeSegment(header.id))
	await mkdir(dir, { recursive: true })
	await writeFile(join(dir, 'session.v3.jsonl.zstd'), Buffer.alloc(bytes, 7))
	return dir
}

const HEADER_BASE = { createdAt: 1, delegationDepth: 0, isSeeded: false }

await test('removes the session and its recorded sub-session tree', async () => {
	const parent = { header: { ...HEADER_BASE, id: 'session-parent', cwd: 'C:\\work\\alpha' }, bytes: 100 }
	const child = { header: { ...HEADER_BASE, id: 'session-child', cwd: 'C:\\work\\alpha', parentSession: 'session-parent', origin: 'subagent' }, bytes: 40 }
	const grandchild = { header: { ...HEADER_BASE, id: 'session-grandchild', cwd: 'C:\\work\\alpha', parentSession: 'session-child', origin: 'subagent' }, bytes: 10 }
	const fork = { header: { ...HEADER_BASE, id: 'session-fork', cwd: 'C:\\work\\alpha', parentSession: 'session-parent' }, bytes: 7 }
	const unrelated = { header: { ...HEADER_BASE, id: 'session-other', cwd: 'C:\\work\\alpha' }, bytes: 5 }
	const dirs = []
	for (const entry of [parent, child, grandchild, fork, unrelated]) dirs.push(await writeSession(entry.header, entry.bytes))
	const cacheRoot = join(dirname(root), 'storages', 'session_projcache', 'sessions')
	await mkdir(cacheRoot, { recursive: true })
	for (const id of ['session-parent', 'session-child', 'session-grandchild', 'session-fork']) {
		await writeFile(join(cacheRoot, `${id}.json`), '{}')
	}
	const { ctx, archived, detached, events } = makeContext([parent, child, grandchild, fork, unrelated])

	const result = await performDelete(ctx, 'session-parent')
	assert.equal(result.ok, true)
	assert.deepEqual(result.value.removedSessionIds.sort(), ['session-child', 'session-grandchild', 'session-parent'])
	assert.equal(result.value.childrenRemoved, 2)
	assert.equal(result.value.totalBytes, 150)
	assert.equal(result.value.projectionCacheRemoved, 3)
	assert.deepEqual(
		result.value.removedDirectories.map((path) => basename(path)),
		['session-grandchild', 'session-child', 'session-parent'],
	)
	assert.deepEqual(archived, [])
	assert.deepEqual(detached, ['session-parent'])
	assert.deepEqual(events, [['api-session/removed', 'session-parent']])
	const fs = await import('node:fs/promises')
	for (const [index, dir] of dirs.entries()) {
		if (index === 3 || index === 4) continue
		await assert.rejects(fs.stat(dir), /ENOENT/)
	}
	await fs.stat(dirs[3])
	await fs.stat(dirs[4])
	await assert.rejects(fs.stat(join(cacheRoot, 'session-parent.json')), /ENOENT/)
	await assert.rejects(fs.stat(join(cacheRoot, 'session-child.json')), /ENOENT/)
	await assert.rejects(fs.stat(join(cacheRoot, 'session-grandchild.json')), /ENOENT/)
	await fs.stat(join(cacheRoot, 'session-fork.json'))
})

await test('keeps the parent visible when a sub-session removal fails, then retries', async () => {
	const parent = { header: { ...HEADER_BASE, id: 'session-parent', cwd: 'C:\\work\\alpha' }, bytes: 100 }
	const childA = { header: { ...HEADER_BASE, id: 'session-child-a', cwd: 'C:\\work\\alpha', parentSession: 'session-parent', origin: 'subagent' }, bytes: 40 }
	const childB = { header: { ...HEADER_BASE, id: 'session-child-b', cwd: 'C:\\work\\alpha', parentSession: 'session-parent', origin: 'subagent' }, bytes: 30 }
	const parentDir = await writeSession(parent.header, 100)
	const childADir = await writeSession(childA.header, 40)
	const childBDir = await writeSession(childB.header, 30)
	const cacheRoot = join(dirname(root), 'storages', 'session_projcache', 'sessions')
	await mkdir(cacheRoot, { recursive: true })
	for (const id of ['session-parent', 'session-child-a', 'session-child-b']) {
		await writeFile(join(cacheRoot, `${id}.json`), '{}')
	}
	const { ctx, archived, detached, events, unarchived } = makeContext([parent, childA, childB])
	const failChildA = async (path, options) => {
		if (path === childADir) throw new Error('locked for test')
		return rm(path, options)
	}

	const first = await performDelete(ctx, 'session-parent', { remove: failChildA })
	assert.equal(first.ok, false)
	assert.equal(first.error.code, 'delete-failed')
	assert.deepEqual(first.error.details.removedSessionIds, ['session-child-b'])
	assert.deepEqual(first.error.details.failedSessionIds, ['session-child-a'])
	assert.deepEqual(first.error.details.removedDirectories, [childBDir])
	assert.equal(first.error.details.parentExists, true)
	assert.equal(first.error.details.parentWasArchived, false)
	assert.equal(first.error.details.archiveRestored, true)
	assert.deepEqual(first.error.details.failures, [{ path: childADir, message: 'locked for test' }])
	assert.deepEqual(archived, [])
	assert.deepEqual(detached, [])
	assert.deepEqual(events, [])
	assert.deepEqual(unarchived, ['session-parent'])
	const fs = await import('node:fs/promises')
	await assert.rejects(fs.stat(childBDir), /ENOENT/)
	await fs.stat(childADir)
	await fs.stat(parentDir)
	await fs.stat(join(cacheRoot, 'session-parent.json'))
	await fs.stat(join(cacheRoot, 'session-child-a.json'))
	await assert.rejects(fs.stat(join(cacheRoot, 'session-child-b.json')), /ENOENT/)

	const retry = await performDelete(ctx, 'session-parent')
	assert.equal(retry.ok, true)
	assert.deepEqual(retry.value.removedSessionIds.sort(), ['session-child-a', 'session-parent'])
	assert.deepEqual(retry.value.skipped, [{ sessionId: 'session-child-b', reason: 'missing' }])
	assert.deepEqual(archived, [])
	assert.deepEqual(detached, ['session-parent'])
	assert.deepEqual(events, [['api-session/removed', 'session-parent']])
	for (const dir of [parentDir, childADir, childBDir]) await assert.rejects(fs.stat(dir), /ENOENT/)
	for (const id of ['session-parent', 'session-child-a', 'session-child-b']) {
		await assert.rejects(fs.stat(join(cacheRoot, `${id}.json`)), /ENOENT/)
	}
})

await test('leaves a pre-archived parent archived when a child fails', async () => {
	const parent = { header: { ...HEADER_BASE, id: 'session-parent', cwd: 'C:\\work\\alpha' }, bytes: 100 }
	const child = { header: { ...HEADER_BASE, id: 'session-child', cwd: 'C:\\work\\alpha', parentSession: 'session-parent', origin: 'subagent' }, bytes: 40 }
	const childDir = await writeSession(child.header, 40)
	await writeSession(parent.header, 100)
	const { ctx, archived, detached, events, unarchived } = makeContext([parent, child])
	archived.push('session-parent')

	const result = await performDelete(ctx, 'session-parent', {
		remove: async (path, options) => {
			if (path === childDir) throw new Error('child locked')
			return rm(path, options)
		},
	})
	assert.equal(result.ok, false)
	assert.equal(result.error.code, 'delete-failed')
	assert.equal(result.error.details.parentExists, true)
	assert.equal(result.error.details.parentWasArchived, true)
	assert.equal(result.error.details.archiveRestored, false)
	assert.deepEqual(archived, ['session-parent'])
	assert.deepEqual(unarchived, [])
	assert.deepEqual(detached, [])
	assert.deepEqual(events, [])
	const fs = await import('node:fs/promises')
	await fs.stat(childDir)
})

await test('cleans bookkeeping if the parent disappears during a partial failure', async () => {
	const parent = { header: { ...HEADER_BASE, id: 'session-parent', cwd: 'C:\\work\\alpha' }, bytes: 100 }
	const child = { header: { ...HEADER_BASE, id: 'session-child', cwd: 'C:\\work\\alpha', parentSession: 'session-parent', origin: 'subagent' }, bytes: 40 }
	const parentDir = await writeSession(parent.header, 100)
	const childDir = await writeSession(child.header, 40)
	const entries = [parent, child]
	const { ctx, archived, detached, events } = makeContext(entries)
	const failChild = async () => {
		// Simulate the parent log disappearing out-of-band while the child is locked.
		await rm(parentDir, { recursive: true, force: true })
		const index = entries.findIndex((entry) => entry.header.id === 'session-parent')
		if (index >= 0) entries.splice(index, 1)
		throw new Error('child locked')
	}

	const result = await performDelete(ctx, 'session-parent', { remove: failChild })
	assert.equal(result.ok, false)
	assert.equal(result.error.code, 'delete-failed')
	assert.deepEqual(result.error.details.removedSessionIds, [])
	assert.deepEqual(result.error.details.failedSessionIds, ['session-child'])
	assert.equal(result.error.details.parentExists, false)
	assert.equal(result.error.details.archiveRestored, false)
	assert.deepEqual(archived, [])
	assert.deepEqual(detached, ['session-parent'])
	assert.deepEqual(events, [['api-session/removed', 'session-parent']])
	const fs = await import('node:fs/promises')
	await fs.stat(childDir)
})

await test('removes an already archived session and announces its removal', async () => {
	const parent = { header: { ...HEADER_BASE, id: 'session-archived', cwd: 'C:\\work\\alpha' }, bytes: 33 }
	const dir = await writeSession(parent.header, 33)
	const { ctx, archived, detached, events } = makeContext([parent])
	archived.push('session-archived')

	const result = await performDelete(ctx, 'session-archived')
	assert.equal(result.ok, true)
	assert.deepEqual(result.value.removedSessionIds, ['session-archived'])
	assert.deepEqual(archived, [])
	assert.deepEqual(detached, ['session-archived'])
	assert.deepEqual(events, [['api-session/removed', 'session-archived']])
	const fs = await import('node:fs/promises')
	await assert.rejects(fs.stat(dir), /ENOENT/)
})

await test("refuses when a target session's Agent is running", async () => {
	const parent = { header: { ...HEADER_BASE, id: 'session-parent', cwd: 'C:\\work\\alpha' }, bytes: 100 }
	const child = { header: { ...HEADER_BASE, id: 'session-child', cwd: 'C:\\work\\alpha', parentSession: 'session-parent', origin: 'subagent' }, bytes: 40 }
	await writeSession(parent.header)
	const childDir = await writeSession(child.header)
	const { ctx, archived } = makeContext([parent, child], { running: new Set(['session-child']) })

	const result = await performDelete(ctx, 'session-parent')
	assert.equal(result.ok, false)
	assert.equal(result.error.code, 'session-live')
	assert.deepEqual(result.error.details.sessionIds, ['session-child'])
	assert.deepEqual(archived, [])
	const fs = await import('node:fs/promises')
	await fs.stat(childDir)
})

await test('deletes a session whose resident Agent is idle', async () => {
	const parent = { header: { ...HEADER_BASE, id: 'session-idle', cwd: 'C:\\work\\alpha' }, bytes: 18 }
	const dir = await writeSession(parent.header, 18)
	const { ctx, archived, detached, events } = makeContext([parent], { resident: new Set(['session-idle']) })

	const result = await performDelete(ctx, 'session-idle')
	assert.equal(result.ok, true)
	assert.deepEqual(result.value.removedSessionIds, ['session-idle'])
	assert.deepEqual(archived, [])
	assert.deepEqual(detached, ['session-idle'])
	assert.deepEqual(events, [['api-session/removed', 'session-idle']])
	const fs = await import('node:fs/promises')
	await assert.rejects(fs.stat(dir), /ENOENT/)
})

await test('refuses while the workspace activity waterfall reports work', async () => {
	const parent = { header: { ...HEADER_BASE, id: 'session-parent', cwd: 'C:\\work\\alpha' }, bytes: 100 }
	await writeSession(parent.header)
	const { ctx, archived } = makeContext([parent], {
		activity: [{ kind: 'job', id: 'job-1', name: 'nightly build' }],
	})

	const result = await performDelete(ctx, 'session-parent')
	assert.equal(result.ok, false)
	assert.equal(result.error.code, 'session-active')
	assert.deepEqual(result.error.details.activity, [{ kind: 'job', id: 'job-1', name: 'nightly build' }])
	assert.deepEqual(archived, [])
})

await test('cleans bookkeeping when the session is already gone', async () => {
	const { ctx, archived, detached, events } = makeContext([])
	const result = await performDelete(ctx, 'session-missing')
	assert.equal(result.ok, false)
	assert.equal(result.error.code, 'session-not-found')
	assert.deepEqual(archived, [])
	assert.deepEqual(detached, ['session-missing'])
	assert.deepEqual(events, [['api-session/removed', 'session-missing']])
})

await test('succeeds with a skipped entry when the log directory is already gone', async () => {
	const parent = { header: { ...HEADER_BASE, id: 'session-parent', cwd: 'C:\\work\\alpha' }, bytes: 100 }
	const { ctx, archived, detached } = makeContext([parent])
	const result = await performDelete(ctx, 'session-parent')
	assert.equal(result.ok, true)
	assert.deepEqual(result.value.removedSessionIds, [])
	assert.deepEqual(result.value.removedDirectories, [])
	assert.deepEqual(result.value.skipped, [{ sessionId: 'session-parent', reason: 'missing' }])
	assert.equal(result.value.totalBytes, 0)
	assert.equal(result.value.childrenRemoved, 0)
	assert.deepEqual(archived, [])
	assert.deepEqual(detached, ['session-parent'])
})

await test('rolls the archive back when no directory could be removed', async () => {
	const parent = { header: { ...HEADER_BASE, id: 'session-parent', cwd: 'C:\\work\\alpha' }, bytes: 100 }
	// A file at the store root makes the directory scan fail after archiving.
	await rm(root, { recursive: true, force: true })
	await writeFile(root, 'not a session store')
	const { ctx, archived, unarchived } = makeContext([parent])

	const result = await performDelete(ctx, 'session-parent')
	assert.equal(result.ok, false)
	assert.equal(result.error.code, 'delete-failed')
	assert.deepEqual(archived, [])
	assert.deepEqual(unarchived, ['session-parent'])
})

await test('supports sessions without a cwd under _no-cwd', async () => {
	const parent = { header: { ...HEADER_BASE, id: 'session-parent' }, bytes: 12 }
	await writeSession(parent.header, 12)
	const { ctx } = makeContext([parent])
	const result = await performDelete(ctx, 'session-parent')
	assert.equal(result.ok, true)
	assert.equal(result.value.removedSessionIds.length, 1)
})

await test('finds a log under a project directory even when the header omits cwd', async () => {
	const parent = { header: { ...HEADER_BASE, id: 'session-no-cwd' }, bytes: 21 }
	const dir = join(root, '--legacy-project--', encodeSegment('session-no-cwd'))
	await mkdir(dir, { recursive: true })
	await writeFile(join(dir, 'session.v4.jsonl.zstd'), Buffer.alloc(21, 3))
	const { ctx } = makeContext([parent])
	const result = await performDelete(ctx, 'session-no-cwd')
	assert.equal(result.ok, true)
	assert.deepEqual(result.value.removedDirectories, [dir])
	await assert.rejects(import('node:fs/promises').then((fs) => fs.stat(dir)), /ENOENT/)
})

await test('encodes traversal-shaped ids without leaving the store root', () => {
	assert.equal(encodeSegment('../evil'), '..~002Fevil')
})

await test('refuses a symlinked session directory and keeps its target intact', async () => {
	const parent = { header: { ...HEADER_BASE, id: 'session-link', cwd: 'C:\\work\\alpha' }, bytes: 10 }
	const outside = join(dirname(root), 'outside-link')
	await mkdir(outside, { recursive: true })
	await writeFile(join(outside, 'keep.txt'), 'keep')
	const project = join(root, '--test-project--')
	await mkdir(project, { recursive: true })
	const link = join(project, encodeSegment('session-link'))
	await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
	const { ctx, archived, detached, events } = makeContext([parent])

	const result = await performDelete(ctx, 'session-link')
	assert.equal(result.ok, false)
	assert.equal(result.error.code, 'delete-failed')
	assert.deepEqual(result.error.details.failedSessionIds, ['session-link'])
	assert.deepEqual(result.error.details.removedSessionIds, [])
	assert.equal(result.error.details.parentExists, true)
	assert.equal(result.error.details.archiveRestored, true)
	assert.deepEqual(archived, [])
	assert.deepEqual(detached, [])
	assert.deepEqual(events, [])
	assert.match(result.error.message, /refusing symlinked session directory/)
	const fs = await import('node:fs/promises')
	assert.equal((await fs.stat(join(outside, 'keep.txt'))).size, 4)
	assert.equal((await fs.lstat(link)).isSymbolicLink(), true)
})

await test('does not escape the store root for traversal-shaped ids', async () => {
	const id = '../outside'
	const parent = { header: { ...HEADER_BASE, id, cwd: 'C:\\work\\alpha' }, bytes: 10 }
	const encodedDir = await writeSession(parent.header, 10)
	const outside = join(dirname(root), 'outside')
	await mkdir(outside, { recursive: true })
	await writeFile(join(outside, 'keep.txt'), 'keep')
	const { ctx, detached, events } = makeContext([parent])

	const result = await performDelete(ctx, id)
	assert.equal(result.ok, true)
	assert.deepEqual(result.value.removedSessionIds, [id])
	assert.deepEqual(detached, [id])
	assert.deepEqual(events, [['api-session/removed', id]])
	const fs = await import('node:fs/promises')
	await assert.rejects(fs.stat(encodedDir), /ENOENT/)
	await fs.stat(join(outside, 'keep.txt'))
})

await rm(TMP, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
