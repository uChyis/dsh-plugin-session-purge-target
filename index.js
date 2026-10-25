/**
 * Host half of the Session Delete plugin.
 *
 * The Harness persistence seam deliberately has no deletion API: session logs
 * are append-only files under `$DSH_HOME/sessions`. This plugin therefore
 * deletes exactly one session-owned directory (plus the directories of its
 * recorded sub-sessions) after the Workspace registry has hidden the row.
 * It never deletes a session that still has a live Agent or Session, and it
 * never follows a session directory that resolves outside the store root.
 */
import { lstat, readdir, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

const CHANNEL = '/dsh-session-delete'
const ENDPOINT = 'delete'
const MAX_SESSIONS = 512

export const inject = ['connection', 'sessionPersistence', 'workspaceRegistry', 'agents', 'webServer']

/**
 * Register the Client-callable delete endpoint.
 *
 * The generic `connection.rpc` registry cannot be used here: its channel
 * registration reaches for `webServer` on the Connection service's own fiber,
 * which does not declare that service. The exact route is registered directly
 * and authenticated through the documented `connection.requestRejection()`
 * fence, while the wire envelope stays identical to a Connection unary call.
 * @param ctx - Host context carrying connection, persistence, and workspace services.
 */
export function apply(ctx) {
	const inFlight = new Set()
	const handler = async (payload) => {
		const sessionId = readSessionId(payload)
		if (sessionId === undefined) return failure('bad-request', 'payload.sessionId must be a non-empty string without surrounding whitespace')
		if (inFlight.has(sessionId)) return failure('busy', 'this session is already being deleted')
		inFlight.add(sessionId)
		try {
			return await performDelete(ctx, sessionId)
		} catch (error) {
			return failure('delete-failed', errorMessage(error))
		} finally {
			inFlight.delete(sessionId)
		}
	}
	const route = {
		kind: 'prefix',
		path: CHANNEL,
		handler: (request, response) => serveRpc(ctx, request, response, handler),
	}
	ctx.effect(() => ctx.webServer.register(route), 'session-delete: RPC route')
}

/**
 * Serve one Connection-style unary envelope over a plain web-server route.
 * @param ctx - Host context whose Connection fence authenticates the request.
 * @param request - Incoming HTTP request.
 * @param response - Response owned to completion.
 * @param handler - Operation receiving the envelope payload.
 */
async function serveRpc(ctx, request, response, handler) {
	let rejection
	try {
		rejection = ctx.connection.requestRejection(request)
	} catch {
		rejection = 403
	}
	if (rejection !== undefined) {
		end(response, rejection, rejection === 401 ? 'unauthorized' : 'forbidden')
		return
	}
	let pathname
	try {
		pathname = new URL(request.url ?? '/', 'http://localhost').pathname
	} catch {
		end(response, 400, 'bad request URL')
		return
	}
	if (pathname !== `${CHANNEL}/${ENDPOINT}`) {
		end(response, 404, 'not found')
		return
	}
	if (request.method !== 'POST') {
		end(response, 405, 'method not allowed')
		return
	}
	const type = String(request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
	if (type !== 'application/json') {
		end(response, 415, 'content type must be application/json')
		return
	}
	const envelope = await readJsonEnvelope(request)
	if (envelope === undefined) {
		end(response, 400, 'body is not a client-request')
		return
	}
	let result
	try {
		result = await handler(envelope.payload)
	} catch (error) {
		result = failure('internal', errorMessage(error))
	}
	const text = JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result })
	response.writeHead(200, {
		'content-type': 'application/json',
		'content-length': Buffer.byteLength(text),
	})
	response.end(text)
}

const MAX_ENVELOPE_BYTES = 64 * 1024

/**
 * Read and minimally validate one `client-request` JSON envelope.
 * @param request - Incoming HTTP request.
 * @returns The envelope, or undefined for a malformed/oversized body.
 */
async function readJsonEnvelope(request) {
	let size = 0
	const chunks = []
	try {
		for await (const chunk of request) {
			size += chunk.length
			if (size > MAX_ENVELOPE_BYTES) return undefined
			chunks.push(chunk)
		}
		const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
		if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
		if (value.type !== 'client-request' || typeof value.rpcId !== 'string' || value.method !== ENDPOINT) return undefined
		return { rpcId: value.rpcId, payload: value.payload }
	} catch {
		return undefined
	}
}

function end(response, status, text) {
	if (!response.headersSent) {
		response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
	}
	response.end(text)
}

/**
 * Delete one session and its recorded sub-session tree.
 * @param ctx - Host context with session persistence, workspace registry, and live registries.
 * @param sessionId - Exact stored session id.
 * @param options - Optional caller cancellation.
 * @returns A wire result: `{ ok: true, value }` or `{ ok: false, error }`.
 */
export async function performDelete(ctx, sessionId, options = {}) {
	const { signal } = options
	signal?.throwIfAborted()

	const store = ctx.sessionPersistence
	const stat = await store.stat(sessionId, { signal })
	if (stat === undefined) {
		// A row can outlive its log: it stays in the Workspace membership and the
		// Client list as an archived ghost. A retry on that ghost should clean the
		// bookkeeping and tell the list the identity is gone.
		await cleanupWorkspaceMembership(ctx, sessionId)
		announceRemoval(ctx, sessionId)
		return failure('session-not-found', `session "${sessionId}" was not found`)
	}

	const snapshots = await store.list({ signal })
	const targets = collectDeletionTargets(sessionId, stat, snapshots)

	const runningIds = targets.map((target) => target.header.id).filter((id) => isRunning(ctx, id))
	if (runningIds.length > 0) {
		return failure('session-live', 'the session still has a running agent', { sessionIds: runningIds })
	}

	const activity = await sessionActivity(ctx, sessionId)
	if (activity.length > 0) {
		return failure('session-active', 'the session still has running work', { activity: sanitizeActivity(activity) })
	}

	const root = store.root
	if (typeof root !== 'string' || !isAbsolute(root)) {
		return failure('unsupported-backend', 'the mounted session store does not expose a JSONL root directory')
	}
	const rootReal = await canonicalRoot(root)
	if (rootReal === undefined) return failure('store-unavailable', `session store root "${root}" does not exist`)

	const wasArchived = Array.isArray(ctx.workspaceRegistry.archivedSessionIds)
		? ctx.workspaceRegistry.archivedSessionIds.includes(sessionId)
		: false
	try {
		await ctx.workspaceRegistry.archiveSession(sessionId)
	} catch (error) {
		if (error?.name === 'WorkspaceActiveSessionError') {
			return failure('session-active', 'the session still has running work', { activity: sanitizeActivity(error.activity) })
		}
		if (error?.name === 'WorkspaceUnknownSessionError') {
			return failure('session-not-found', `session "${sessionId}" was not found`)
		}
		throw error
	}

	const removedDirectories = []
	const skipped = []
	try {
		const projects = await readdir(rootReal, { withFileTypes: true })
		for (const target of targets) {
			signal?.throwIfAborted()
			const outcome = await removeSessionDirectories(rootReal, target.header, projects)
			removedDirectories.push(...outcome.paths)
			if (outcome.failures.length > 0) {
				const error = new Error(outcome.failures.map((failure) => `${failure.path}: ${failure.message}`).join('; '))
				error.failures = outcome.failures
				throw error
			}
			if (outcome.paths.length === 0) skipped.push({ sessionId: target.header.id, reason: 'missing' })
		}
	} catch (error) {
		// Hidden rows with a half-deleted log are worse than a hidden row that
		// the user can restore, so only roll the archive back when nothing moved.
		if (removedDirectories.length === 0 && !wasArchived) {
			try {
				await ctx.workspaceRegistry.unarchiveSession(sessionId)
			} catch {
				// The archive set is a convenience rollback; the delete failure is the report.
			}
		}
		return failure('delete-failed', errorMessage(error), {
			removedSessionIds: targets.map((target) => target.header.id),
			removedDirectories,
			skipped,
			...(Array.isArray(error?.failures) ? { failures: error.failures } : {}),
		})
	}

	const removedSessionIds = targets.map((target) => target.header.id)
	const removedCaches = await removeProjectionCaches(rootReal, removedSessionIds)

	// The sidebar row is kept alive by the Workspace membership and the Session
	// list; the archive only hides it. Drop the membership and archived mark,
	// then announce the identity removal so the row and its resident Session
	// release together.
	await cleanupWorkspaceMembership(ctx, sessionId)
	announceRemoval(ctx, sessionId)

	return success({
		sessionId,
		removedSessionIds,
		removedDirectories,
		skipped,
		projectionCacheRemoved: removedCaches,
		totalBytes: targets.reduce((sum, target) => sum + (typeof target.sizeBytes === 'number' ? target.sizeBytes : 0), 0),
		childrenRemoved: targets.length - 1,
	})
}

/**
 * Order the target session and every recorded descendant by parentSession.
 * @param rootId - Session requested by the user.
 * @param rootStat - Its persistence snapshot.
 * @param snapshots - Every stored session snapshot.
 * @returns Target entries in breadth-first order.
 */
function collectDeletionTargets(rootId, rootStat, snapshots) {
	const byId = new Map()
	byId.set(rootId, { header: rootStat.header, sizeBytes: rootStat.sizeBytes })
	for (const snapshot of snapshots) {
		byId.set(snapshot.header.id, { header: snapshot.header, sizeBytes: snapshot.sizeBytes })
	}

	const children = new Map()
	for (const [id, entry] of byId) {
		const parent = entry.header?.parentSession
		if (typeof parent !== 'string' || parent.length === 0) continue
		// `parentSession` alone can describe non-subagent lineage (for example a
		// fork). Only subagent logs are owned by the parent conversation.
		if (entry.header.origin !== 'subagent') continue
		const bucket = children.get(parent)
		if (bucket === undefined) children.set(parent, [id])
		else bucket.push(id)
	}

	const entries = []
	const seen = new Set()
	const queue = [rootId]
	while (queue.length > 0) {
		const id = queue.shift()
		if (seen.has(id)) continue
		seen.add(id)
		const entry = byId.get(id)
		if (entry === undefined) continue
		entries.push(entry)
		if (entries.length > MAX_SESSIONS) throw new Error(`session tree exceeds ${MAX_SESSIONS} sessions`)
		for (const child of children.get(id) ?? []) queue.push(child)
	}
	return entries
}

/** Whether this process is actively running the session's Agent. Resident idle Agents are deletable. */
function isRunning(ctx, sessionId) {
	return ctx.agents.get(sessionId)?.status === 'running'
}

/** Ask every activity provider once, before archive repeats the check. */
async function sessionActivity(ctx, sessionId) {
	const activity = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
	return Array.isArray(activity) ? activity : []
}

/** Keep provider entries JSON-safe for the wire. */
function sanitizeActivity(activity) {
	if (!Array.isArray(activity)) return []
	return activity.map((entry) => {
		if (entry === null || typeof entry !== 'object') return { kind: String(entry) }
		const { kind, id, name } = entry
		return {
			...(typeof kind === 'string' ? { kind } : {}),
			...(typeof id === 'string' ? { id } : {}),
			...(typeof name === 'string' ? { name } : {}),
		}
	})
}

/**
 * Find and delete every `<root>/<project>/<encodeSegment(id)>` directory.
 *
 * The header's `cwd` is optional and older logs can omit it while still living
 * under a project directory, so the store layout — not the header — decides
 * where the log is. The encoded id is unique and is always the directory leaf.
 * @param root - Canonical session store root.
 * @param header - The session's stored header.
 * @param projects - Immediate project directories under the root, read once per request.
 * @returns Removed paths plus per-path failures.
 */
async function removeSessionDirectories(root, header, projects) {
	const encoded = encodeSegment(header.id)
	const candidates = []
	for (const project of projects) {
		if (!project.isDirectory()) continue
		const candidate = join(root, project.name, encoded)
		let info
		try {
			info = await lstat(candidate)
		} catch (error) {
			if (isMissing(error)) continue
			throw error
		}
		if (!info.isDirectory()) continue
		let canonical
		try {
			canonical = await realpath(candidate)
		} catch (error) {
			if (isMissing(error)) continue
			throw error
		}
		if (!isInside(root, canonical)) throw new Error(`session directory for "${header.id}" resolves outside the store root`)
		candidates.push(candidate)
	}

	const paths = []
	const failures = []
	for (const candidate of candidates) {
		try {
			await rm(candidate, { recursive: true, force: true, maxRetries: 3, retryDelay: 80 })
			paths.push(candidate)
		} catch (error) {
			failures.push({ path: candidate, message: errorMessage(error) })
		}
	}
	return { paths, failures }
}

/**
 * Remove the per-session projection cache records next to the default store.
 * Derived cache loss is recoverable, so this is best-effort and never fails
 * the session deletion.
 * @param sessionRoot - Canonical session store root (`<home>/sessions`).
 * @param sessionIds - Deleted session ids.
 * @returns Number of removed cache files.
 */
async function removeProjectionCaches(sessionRoot, sessionIds) {
	const cacheRoot = join(dirname(sessionRoot), 'storages', 'session_projcache', 'sessions')
	let removed = 0
	for (const id of sessionIds) {
		const file = join(cacheRoot, `${encodeSegment(id)}.json`)
		try {
			await lstat(file)
			await rm(file, { force: true })
			removed += 1
		} catch {
			// Derived cache cleanup is best-effort.
		}
	}
	return removed
}

/**
 * Remove the session from every Workspace membership and the archived set.
 * The registry exposes no session-delete API, but its Workspace entity owns
 * membership (`detachSession`) and the registry owns the archived set. Both
 * are best-effort after the log is gone: a bookkeeping failure must not turn
 * a completed deletion into an error.
 * @param ctx - Host context carrying the Workspace registry.
 * @param sessionId - Deleted session id.
 */
async function cleanupWorkspaceMembership(ctx, sessionId) {
	try {
		for (const workspace of ctx.workspaceRegistry.list()) {
			try {
				await workspace.detachSession(sessionId)
			} catch {
				// Another workspace may still account the id; keep going.
			}
		}
	} catch {
		// An unavailable registry leaves the row to the removal event.
	}
	try {
		await ctx.workspaceRegistry.unarchiveSession(sessionId)
	} catch {
		// Removing the archived mark is best-effort.
	}
}

/**
 * Forward the same identity-removal event the Session controller emits on
 * disposal, so every connected Client drops the row and releases its binding.
 * @param ctx - Host context.
 * @param sessionId - Deleted session id.
 */
function announceRemoval(ctx, sessionId) {
	try {
		ctx.emit('api-session/removed', sessionId)
	} catch {
		// A missing event bus leaves the Workspace removal as the visible signal.
	}
}

/** Resolve the store root, returning undefined when it does not exist yet. */
async function canonicalRoot(root) {	try {
		return await realpath(resolve(root))
	} catch (error) {
		if (isMissing(error)) return undefined
		throw error
	}
}

/** Whether `target` is a proper descendant of `root`. */
function isInside(root, target) {
	const rel = relative(root, target)
	return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
}

/** ENOENT / ENOTDIR mean the directory is already gone. */
function isMissing(error) {
	return error?.code === 'ENOENT' || error?.code === 'ENOTDIR'
}

function readSessionId(payload) {
	if (payload === null || typeof payload !== 'object') return undefined
	const value = payload.sessionId
	if (typeof value !== 'string' || value.length === 0 || value.length > 512) return undefined
	if (value.trim() !== value) return undefined
	return value
}

function errorMessage(error) {
	const message = error instanceof Error ? error.message : String(error)
	return message.length > 800 ? `${message.slice(0, 797)}...` : message
}

function success(value) {
	return { ok: true, value }
}

function failure(code, message, details = {}) {
	return { ok: false, error: { code, message, details } }
}

/**
 * Encode a session id as one safe path segment, injectively over the id.
 * Mirrors `encodeSegment` in `@deepseek-ai/dsh-session-persistence-jsonl`
 * (MIT) so this plugin addresses the same directory the backend writes.
 * @param raw - Non-empty session id.
 * @returns Filesystem-safe, reversible path segment.
 */
export function encodeSegment(raw) {
	if (raw.length === 0) throw new Error('cannot encode an empty path segment')
	if (raw === '.') return '~002E'
	if (raw === '..') return '~002E~002E'
	let out = ''
	for (let i = 0; i < raw.length; i++) {
		const code = raw.charCodeAt(i)
		const ch = String.fromCharCode(code)
		if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
		else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
	}
	return out
}
