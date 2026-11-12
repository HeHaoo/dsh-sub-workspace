/**
 * dsh-sub-workspace — per-workspace affiliate writable paths.
 *
 * Registers ONE cordis row and touches no official row. On activation it
 * decorates the live `sandboxPolicy` service (see `decorate.js`), which is the
 * single seam every sandbox consumer reads through, then registers the
 * `sub_workspace` management tool and the sidebar's HTTP bridge.
 *
 * Requirements this satisfies:
 *   1. no official implementation replaced — one method on a live instance is
 *      wrapped, with an exact restore on unload;
 *   2. affiliates are added/removed per workspace, keyed by the immutable
 *      session cwd, so workspace renames do not orphan them;
 *   3. changes are effective immediately — `resolve()` runs per capability call,
 *      so the next tool call in new AND already-running sessions sees them, and
 *      the `sandbox:policy` prompt section re-renders from the same call.
 *
 * ## Failure policy: never throw from apply()
 *
 * Cordis rethrows whatever `apply()` throws (`_execute` → `throw reason`) and
 * the loader surfaces it at boot, so an exception here can take the WHOLE
 * application down — which is exactly what happened on the first install.
 *
 * A plugin that merely adds a convenience feature must never do that. Every
 * activation step is therefore guarded and degraded independently:
 *
 *   - the decoration fails  → no affiliates, but write/edit/bash keep working;
 *   - the tool fails        → no `sub_workspace` tool, sandbox unchanged;
 *   - the routes fail       → no sidebar UI, tool still available.
 *
 * The reason is always logged at `error` level so the degradation is visible
 * rather than silent.
 *
 * @module dsh-sub-workspace
 */

import { decorateSandboxPolicy, unwrapService } from './decorate.js'
import { installRoutes } from './routes.js'
import { AffiliateStore, storeFile } from './store.js'
import { buildTool } from './tool.js'

/** Stable cordis plugin id (matches the patch row id). */
export const name = 'sub-workspace'

/**
 * Hard dependencies.
 *
 * `sandboxPolicy` is the service to decorate — declaring it here makes Cordis
 * wait until the official `sandbox-policy` row has provided it. `tools` is
 * needed for the management tool.
 */
export const inject = ['tools', 'sandboxPolicy', 'workspaceRegistry']

/**
 * Mount the plugin.
 *
 * Never throws: a failure degrades the plugin instead of failing the boot.
 * @param {object} ctx - cordis context.
 */
export function apply(ctx) {
  const status = { decorated: false, tool: false, routes: false, error: undefined }

  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`[sub-workspace] ${message}`)
    } catch {
      /* logging must never break activation */
    }
  }
  const fail = (stage, error) => {
    const detail = error instanceof Error ? error.message : String(error)
    status.error = `${stage}: ${detail}`
    try {
      ctx.logger?.error?.(`[sub-workspace] ${stage} failed, feature degraded: ${detail}`)
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------- store ---
  let store
  try {
    store = new AffiliateStore(storeFile())
    if (store.lastError !== undefined) warn(store.lastError)
  } catch (error) {
    // Without a store there is nothing to serve; stop cleanly.
    fail('store', error)
    exposeStatus(ctx, status)
    return
  }

  // ----------------------------------------------------------- decoration ---
  let resolvePolicy = () => undefined
  try {
    const service = resolveService(ctx)
    if (service === undefined) {
      fail('decoration', new Error('sandboxPolicy service is unavailable'))
    } else {
      // The RAW instance is what every consumer fiber reads. `ctx.get`/`ctx.sandboxPolicy`
      // hand back a cordis tracing Proxy whose method identity is not stable, which
      // silently broke undo and every reload (see decorate.js). Unwrap before both
      // decorating AND reading, so the read path and the write path agree.
      const target = unwrapService(service)
      // Recorded in the status object: 'unwrapped' means we found the raw
      // instance behind a cordis tracing Proxy (the normal production case);
      // 'as-given' means we decorated the object we were handed (a plain test
      // double, or a host whose Proxy does not expose the original symbol).
      status.serviceSource = target === service ? 'as-given' : 'unwrapped'
      ctx.effect(() => decorateSandboxPolicy(target, store, { warn }), 'sub-workspace: sandboxPolicy.resolve')
      // Read through the raw instance too: a Proxy-wrapped `resolve` may be a
      // fresh shadow function on every access, and calling it would re-enter
      // cordis tracing on a path that is pure diagnostics.
      resolvePolicy = (request = {}) => target.resolve.call(target, request)
      status.decorated = true
    }
  } catch (error) {
    fail('decoration', error)
  }

  // ----------------------------------------------------------------- tool ---
  const toolAvailable = typeof ctx.tools?.register === 'function'
  if (!toolAvailable) {
    fail('tool', new Error('ctx.tools.register is unavailable'))
  } else {
    try {
      const definition = buildTool({ store, resolvePolicy, storePath: storeFile(), log: { warn } })
      ctx.effect(() => ctx.tools.register(definition), 'sub-workspace: sub_workspace tool')
      // `ctx.effect` may run the callback immediately (a real host) or return
      // without doing so; only a registration that did not throw counts.
      status.tool = true
    } catch (error) {
      status.tool = false
      fail('tool', error)
    }
  }

  // --------------------------------------------------------------- routes ---
  // The sidebar UI needs HTTP routes, which require the connection service.
  // Absent in non-Web compositions, in which case only the tool path works.
  if (typeof ctx.inject !== 'function') {
    warn('no inject() available; sidebar routes skipped')
  } else {
    try {
      ctx.inject(['connection'], (scope) => {
        try {
          const connection = scope.get('connection')
          if (connection === undefined) {
            warn('connection service unavailable; sidebar routes skipped')
            return
          }
          // Read the registry from the OUTER context: the inject scope only
          // guarantees `connection`, so `scope.get` would miss it and the list
          // route would publish no workspaces at all — which is exactly the bug
          // that made every sidebar row unidentifiable.
          // Official code reads the registry as a DIRECT property
          // (`ctx.workspaceRegistry.list()`), which is how cordis exposes a
          // provided service on the context. `ctx.get('workspaceRegistry')`
          // returns undefined unless the name is declared in `inject`, which is
          // why the list route published nothing.
          const registry = ctx.workspaceRegistry ?? (typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined)
          if (registry === undefined) {
            // Without it the list route cannot map a sidebar row to a directory,
            // so every row stays undecorated. Say so loudly.
            warn('workspaceRegistry unavailable: the sidebar will list no workspaces')
          }
          scope.effect(
            () =>
              installRoutes({
                store,
                resolvePolicy,
                storePath: storeFile(),
                connection,
                workspaceRegistry: registry,
              }),
            'sub-workspace: /api routes',
          )
          status.routes = true
        } catch (error) {
          // An injection-scope failure must stay inside this scope.
          fail('routes', error)
        }
      })
    } catch (error) {
      fail('routes', error)
    }
  }

  exposeStatus(ctx, status)

  const summary = [
    status.decorated ? 'sandboxPolicy decorated' : 'NO decoration',
    status.tool ? 'tool registered' : 'NO tool',
    status.routes ? 'routes registered' : 'NO routes',
    `${store.keys().length} workspace(s)`,
  ].join('; ')
  try {
    ctx.logger?.info?.(`[sub-workspace] active (${summary})`)
  } catch {
    /* ignore */
  }
}

/**
 * Read the live `sandboxPolicy` service.
 *
 * Official code reads a provided service as a DIRECT property
 * (`ctx.sandboxPolicy.defaultMode`, `ctx.sandboxPolicy.resolve(...)`); that is
 * how cordis exposes it once the name is in `inject`. `ctx.get(name)` is the
 * un-typed escape hatch and needs no `inject` declaration, but it is also the
 * call that hands back the tracing Proxy. Prefer the direct property, fall back
 * to `get` so a partial/legacy host still activates, and let
 * `unwrapService` reconcile whichever we got.
 *
 * @param {object} ctx - cordis context.
 * @returns {object|undefined} the service (possibly a tracing Proxy).
 */
function resolveService(ctx) {
  try {
    const direct = ctx.sandboxPolicy
    if (direct !== undefined) return direct
  } catch {
    /* not declared in `inject` on this host: fall through to get() */
  }
  if (typeof ctx.get === 'function') {
    try {
      return ctx.get('sandboxPolicy')
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Publish a read-only status object so diagnostics can see what degraded
 * without digging through logs. Best-effort: `provide` may already be taken.
 */
function exposeStatus(ctx, status) {
  try {
    if (typeof ctx.provide === 'function') ctx.provide('subWorkspaceStatus', status)
  } catch {
    /* a taken name is not worth failing activation over */
  }
}
