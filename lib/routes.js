/**
 * Host HTTP bridge for the sidebar UI.
 *
 * The browser half cannot touch the plugin's in-process store directly, so the
 * host exposes one authenticated exact Fetch route under the `/api` channel —
 * the official extension point (`ctx.connection.fetch.register`) that the
 * Host/Origin fence and browser-session auth already guard.
 *
 * Routes (all under `/api`):
 *
 *   GET  /api/sub-workspace/list
 *        → { workspaces: [{ workspace, id, title, roots }], storePath }
 *        `workspace` is the directory key affiliates are stored under; `id` is
 *        the sidebar row identity (`data-row-key="workspace:<id>"`), so the
 *        browser can map a clicked row to the right store key without guessing.
 *
 *   POST /api/sub-workspace/mutate
 *        body { workspace, action: 'add'|'remove'|'set', path?, paths? }
 *        → { workspace, roots, ... }  the workspace's resulting roots
 *        Paths may be written as `~/...`; see `expandHome` in paths.js.
 *
 *   GET  /api/sub-workspace/check?path=…
 *        → { path, writable, matchedRoot?, reason }
 *
 * Validation is identical to the tool path: every mutation goes through
 * `validateRoot`, so the UI cannot grant a symlinked or missing directory even
 * if a request is malformed.
 *
 * @module dsh-sub-workspace/routes
 */

import { isUnder, removalCandidates, validateRoot } from './paths.js'

/** Base path of the plugin's API surface. */
export const ROUTE_LIST = '/api/sub-workspace/list'
export const ROUTE_MUTATE = '/api/sub-workspace/mutate'
export const ROUTE_CHECK = '/api/sub-workspace/check'

/** JSON response helper. */
function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/** Read a JSON body, tolerating a missing/empty one. */
async function readJson(request) {
  try {
    const text = await request.text()
    if (text.trim() === '') return {}
    const value = JSON.parse(text)
    return typeof value === 'object' && value !== null ? value : {}
  } catch {
    return {}
  }
}

/**
 * Validate a workspace key: an absolute directory path.
 *
 * Deliberately NOT home-expanded: a workspace key is the immutable
 * `session.header.cwd` recorded by the host, always a real absolute path. A
 * `~/...` key would create a second entry for the same directory, so it is
 * refused here instead.
 */
function assertWorkspaceKey(value) {
  const key = String(value ?? '').trim()
  if (key === '') throw new Error('workspace is required')
  if (!key.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(key)) {
    throw new Error(`workspace must be an absolute directory: ${JSON.stringify(key)}`)
  }
  return key
}

/**
 * Register the three routes.
 *
 * @param {object} deps
 * @param {import('./store.js').AffiliateStore} deps.store
 * @param {(request: object) => object} deps.resolvePolicy - decorated resolve.
 * @param {string} deps.storePath
 * @param {string} deps.enabled - 'true' when the decoration is live.
 * @returns {Array<() => void>} disposers.
 */
export function installRoutes(deps) {
  const { store, resolvePolicy, storePath, workspaceRegistry } = deps

  const listRoute = {
    path: ROUTE_LIST,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      // The sidebar addresses workspaces by id, the store by directory. Publish
      // both so the client never has to infer one from the other.
      const byDir = new Map()
      if (workspaceRegistry !== undefined) {
        try {
          for (const entity of workspaceRegistry.list()) {
            byDir.set(entity.path, { id: entity.id, title: entity.title })
          }
        } catch {
          /* a registry read fault must not hide the affiliate list */
        }
      }
      const workspaces = store.keys().map((workspace) => ({
        workspace,
        roots: store.get(workspace),
        ...(byDir.get(workspace) ?? {}),
      }))
      // Also publish directories that have no affiliates yet but do exist as
      // workspaces, so the panel can show "暂无附属路径" for them.
      if (workspaceRegistry !== undefined) {
        try {
          for (const entity of workspaceRegistry.list()) {
            if (!store.keys().includes(entity.path)) {
              workspaces.push({ workspace: entity.path, roots: [], id: entity.id, title: entity.title })
            }
          }
        } catch {
          /* ignore */
        }
      }
      // Diagnostics ride the response so a broken registry is visible instead of
      // silently yielding an empty list (which looks like "no workspaces").
      return json({
        workspaces,
        storePath,
        registry: workspaceRegistry === undefined ? 'unavailable' : 'ok',
      })
    },
  }

  const mutateRoute = {
    path: ROUTE_MUTATE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body
      try {
        body = await readJson(request)
      } catch {
        return json({ error: 'body is not JSON' }, 400)
      }
      let workspace
      try {
        workspace = assertWorkspaceKey(body.workspace)
      } catch (error) {
        return json({ error: error.message }, 400)
      }

      const action = String(body.action ?? '')
      try {
        switch (action) {
          case 'add': {
            const physical = validateRoot(body.path)
            store.add(workspace, physical)
            return json({ workspace, roots: store.get(workspace), added: physical })
          }
          case 'remove': {
            const raw = String(body.path ?? '').trim()
            if (raw === '') return json({ error: 'path is required' }, 400)
            // Roots are stored physically, so a `~/x` request has to be resolved
            // to the same spelling before the exact-match removal can hit. An
            // unmatched spelling stays a no-op (remove never throws).
            let removed = raw
            let roots = store.get(workspace)
            for (const candidate of removalCandidates(raw)) {
              const next = store.remove(workspace, candidate)
              // A changed length means this spelling was the stored one; stop
              // so one request still removes at most one root, as documented.
              if (next.length !== roots.length) {
                removed = candidate
                roots = next
                break
              }
            }
            return json({ workspace, roots, removed })
          }
          case 'set': {
            if (!Array.isArray(body.paths)) return json({ error: 'paths array is required' }, 400)
            const next = []
            for (const entry of body.paths) {
              const physical = validateRoot(entry)
              if (!next.includes(physical)) next.push(physical)
            }
            store.set(workspace, next)
            return json({ workspace, roots: store.get(workspace) })
          }
          default:
            return json({ error: `unknown action ${JSON.stringify(action)}` }, 400)
        }
      } catch (error) {
        // Validation failures are the user's to fix: 400 with the reason, so the
        // dialog can show exactly which directory was rejected and why.
        return json({ error: error?.message ?? String(error) }, 400)
      }
    },
  }

  const checkRoute = {
    path: ROUTE_CHECK,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const url = new URL(request.url)
      const raw = url.searchParams.get('path')
      if (raw === null || raw.trim() === '') return json({ error: 'path is required' }, 400)
      let physical
      try {
        physical = validateRoot(raw)
      } catch (error) {
        return json({ path: raw, writable: false, reason: error.message })
      }

      // The policy is resolved PER SESSION: without one there is no workspace
      // boundary, so every path (even the workspace root itself) reported
      // "not under any writable root". That made the panel's diagnostic
      // permanently say "不可写" for paths that were in fact writable.
      //
      // Accept the workspace directory the panel is asking about. `workspace`
      // is what the sidebar already knows (it is the store key); `session` is
      // accepted as a plain alias so a caller can pass a cwd under either name.
      const workspaceParam = (url.searchParams.get('workspace') ?? url.searchParams.get('session') ?? '').trim()
      let policy
      if (workspaceParam === '') {
        // Backwards compatible: no session context -> the deployment's
        // agentless policy. Say WHY the answer is weak instead of failing.
        policy = resolvePolicy({})
        if (policy?.mode === 'workspace-write') {
          const roots = [policy?.workspaceRoot, ...(policy?.additionalWritableRoots ?? [])].filter(
            (root) => typeof root === 'string' && root !== '',
          )
          const hit = roots.find((root) => isUnder(physical, root))
          return json({
            path: physical,
            writable: hit !== undefined,
            matchedRoot: hit,
            // Keep the historical reason string byte-identical (callers and
            // tests match on it); the actionable guidance rides beside it.
            reason: hit === undefined ? 'not under any writable root' : 'under a writable root',
            hint:
              hit === undefined
                ? 'pass ?workspace=<session cwd> to check the policy of a specific workspace'
                : undefined,
            workspace: undefined,
          })
        }
      } else {
        let sessionCwd
        try {
          sessionCwd = assertWorkspaceKey(workspaceParam)
        } catch (error) {
          return json({ path: physical, writable: false, reason: error.message })
        }
        policy = resolvePolicy({ session: { header: { cwd: sessionCwd } } })
        if (policy === undefined) {
          return json({ path: physical, writable: false, reason: 'no policy for that workspace', workspace: sessionCwd })
        }
      }

      if (policy?.mode === 'danger-full-access') {
        return json({ path: physical, writable: true, reason: 'danger-full-access is unrestricted' })
      }
      if (policy?.mode === 'read-only') {
        return json({ path: physical, writable: false, reason: 'sandbox mode is read-only' })
      }
      const roots = [policy?.workspaceRoot, ...(policy?.additionalWritableRoots ?? [])].filter(
        (root) => typeof root === 'string' && root !== '',
      )
      const hit = roots.find((root) => isUnder(physical, root))
      return json({
        path: physical,
        writable: hit !== undefined,
        matchedRoot: hit,
        reason: hit === undefined ? 'not under any writable root' : 'under a writable root',
        ...(workspaceParam === '' ? {} : { workspace: policy?.workspaceRoot ?? workspaceParam }),
      })
    },
  }

  const connection = deps.connection
  const disposers = []
  for (const route of [listRoute, mutateRoute, checkRoute]) {
    disposers.push(connection.fetch.register(route))
  }
  return disposers
}
