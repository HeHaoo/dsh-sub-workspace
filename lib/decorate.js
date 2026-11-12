/**
 * Runtime decoration of the live `sandboxPolicy` service.
 *
 * ## Why decorate instead of providing a replacement
 *
 * `SandboxPolicyService` extends cordis `Service`, whose constructor registers
 * itself (`this.ctx.reflect.provide(name, self, ...)`). Constructing a second
 * instance therefore collides with the official row, and `reflect.set()` refuses
 * a caller from another fiber. Replacing the service would also mean disabling
 * the official `sandbox-policy` row — i.e. editing the deployment, which this
 * plugin exists to avoid.
 *
 * So we mutate the ALREADY-REGISTERED instance: wrap `resolve`, keep everything
 * else (the `sandboxMode` projection, session-mode fold, `defaultMode`,
 * `workspaceRoot`, prompt context) exactly as the official implementation left
 * it. One method changes; fourteen consumers are covered at once because they
 * all read the policy through `resolve()`:
 *
 *   fs-sandbox · tool-fs · tool-bash · tool-pwsh · bash-sandbox ·
 *   pwsh-sandbox · terminal-bash · ptc-runtime-node · worktree · liveshare ·
 *   forge · plugin-manager · sandbox-policy itself · sandbox (debug)
 *
 * ## Why this makes "immediately effective" true
 *
 * `resolve()` is called per capability call — no consumer caches it (verified in
 * `dsh-tool-fs` `resolvePolicy()` and `dsh-tool-bash` `resolveSandboxPolicy()`).
 * The prompt section `sandbox:policy` also re-renders `resolve()` on every model
 * step. So the next tool call, in a brand-new OR an already-running historical
 * session, sees the new roots.
 *
 * ## The Proxy trap that made decoration invisible (root cause of bug 2)
 *
 * Cordis does not hand out the raw service instance. `ctx.get(name)` and
 * `ctx.sandboxPolicy` both return a tracing Proxy built by `createTraceable`
 * (cordis/src/utils.ts). That Proxy is *not* identity-transparent:
 *
 *   - `get` wraps every method in `createShadowMethod`, so
 *     `proxy.resolve !== rawInstance.resolve` **always**, even right after we
 *     assigned our wrapper;
 *   - `set` forwards to the target, so writing through the Proxy *does* reach
 *     the instance (verified against real cordis 4.0.5).
 *
 * The original code wrote through the Proxy (harmless) but then compared
 * `service.resolve === decorated` for BOTH the idempotence marker and undo.
 * Through a Proxy that comparison is always false, so:
 *
 *   1. the first decoration worked;
 *   2. its undo() silently did nothing — the marker and wrapper stayed;
 *   3. every later activation (row reload / profile edit) threw
 *      "already decorated; refusing to stack wrappers" and was swallowed by
 *      apply()'s catch, so the plugin kept the *first* store closure forever;
 *   4. roots added afterwards were written to disk and reported by the routes,
 *      yet the live resolve() never saw them — exactly the reported symptom.
 *
 * The fix: unwrap to the raw instance (`Symbol.for('cordis.original')`) and do
 * every read, write, marker check and restore on THAT object. Reading through
 * the raw instance makes the identity comparisons meaningful again.
 *
 * @module dsh-sub-workspace/decorate
 */

/** Marker recording which raw service instances this plugin already wrapped. */
const DECORATED = Symbol.for('dsh-sub-workspace.decorated')

/**
 * The unwrapped "original" symbol cordis exposes on every traceable Proxy
 * (`createTraceable`'s `get` trap returns `target` for it).
 */
const ORIGINAL = Symbol.for('cordis.original')

/**
 * Resolve the object a decoration must be written to.
 *
 * Cordis hands out a tracing Proxy; mutating the raw instance is what every
 * consumer fiber actually reads. Fall back to the value we were given when it
 * is not a cordis traceable (plain tests, other hosts), so decoration still
 * works — only with the weaker guarantee that the caller itself is the owner.
 *
 * @param {object} service - a service instance or a cordis tracing Proxy.
 * @returns {object} the object to read/write `resolve` on.
 */
export function unwrapService(service) {
  if (service === null || typeof service !== 'object') return service
  try {
    const raw = service[ORIGINAL]
    if (raw !== undefined && raw !== null && typeof raw === 'object') return raw
  } catch {
    /* an exotic Proxy getter must not break activation */
  }
  return service
}

/**
 * Decorate one live sandbox-policy service with affiliate roots.
 *
 * @param {object} service - the registered `sandboxPolicy` instance.
 * @param {{rootsFor: (request: object) => readonly string[]}} store - affiliate source.
 * @param {{ warn?: (message: string) => void }} [log]
 * @returns {() => void} undo, restoring the original `resolve`.
 * @throws Error when the service cannot be decorated (wrong shape / already wrapped).
 */
export function decorateSandboxPolicy(service, store, log = {}) {
  const warn = typeof log.warn === 'function' ? log.warn : () => {}
  if (service === null || typeof service !== 'object') {
    throw new Error('sub-workspace: sandboxPolicy service is not an object')
  }
  // Unwrap FIRST: every later read/write/comparison must target the raw
  // instance. Through a cordis Proxy these all look different, which is what
  // broke idempotence, undo, and every reload (see the module docblock).
  const target = unwrapService(service)
  if (typeof target.resolve !== 'function') {
    throw new Error('sub-workspace: sandboxPolicy service has no resolve() to decorate')
  }
  if (target[DECORATED] === true) {
    throw new Error('sub-workspace: sandboxPolicy is already decorated; refusing to stack wrappers')
  }

  // Read from the raw instance so `target.resolve === decorated` is a real
  // identity test in the marker check and in undo().
  const original = target.resolve
  // Whether `resolve` was an OWN property before we touched the instance. The
  // official SandboxPolicyService inherits it from its prototype, so undo must
  // DELETE our own property instead of leaving an own `resolve` shadowing the
  // prototype — otherwise the "exact restore" is not exact.
  const ownBefore = Object.hasOwn(target, 'resolve')
  let warnedShape = false

  /** @param {object} [request] */
  const decorated = function resolve(request = {}) {
    const policy = original.call(target, request)
    // A non-object policy means the official contract changed under us. Never
    // break writes to "add" a root: return whatever the official code produced.
    if (policy === null || typeof policy !== 'object') {
      if (!warnedShape) {
        warnedShape = true
        warn('sub-workspace: resolve() did not return an object; affiliate roots are skipped')
      }
      return policy
    }
    // Only workspace-write accepts extra roots. read-only grants nothing and
    // danger-full-access is already unrestricted, so adding entries there would
    // be meaningless noise in the prompt.
    if (policy.mode !== 'workspace-write') return policy

    let extra
    try {
      extra = store.rootsFor(request)
    } catch (error) {
      warn(`sub-workspace: affiliate lookup failed: ${error?.message ?? error}`)
      return policy
    }
    if (extra.length === 0) return policy

    const existing = Array.isArray(policy.additionalWritableRoots)
      ? policy.additionalWritableRoots
      : EMPTY_ROOTS
    // `writableRoots()` canonicalizes and de-duplicates downstream, but keeping
    // the resolved policy clean means the prompt text stays readable too.
    const merged = dedupe([...existing, ...extra])
    return { ...policy, additionalWritableRoots: merged }
  }

  target.resolve = decorated
  target[DECORATED] = true

  return function undo() {
    // Restore only if nobody re-decorated over us; otherwise leave the newer
    // wrapper in place and just drop our marker. This identity comparison is
    // only meaningful because `target` is the raw instance, not a Proxy.
    if (target.resolve === decorated) {
      // Restore the EXACT previous shape, not merely the previous function.
      // The official service inherits `resolve` from its prototype, so our
      // assignment created an own property. Putting the inherited function back
      // as an OWN property would leave a permanent shadow on the instance —
      // "works the same" but not the exact restore this function promises (and
      // it would hide a later prototype-level change). Delete in that case;
      // only re-assign when `resolve` really was an own property originally.
      if (ownBefore === false) delete target.resolve
      else target.resolve = original
      delete target[DECORATED]
    }
  }
}

/** Order-preserving de-duplication of a root list. */
function dedupe(roots) {
  const seen = new Set()
  const out = []
  for (const root of roots) {
    if (typeof root !== 'string' || root === '') continue
    if (seen.has(root)) continue
    seen.add(root)
    out.push(root)
  }
  return out
}

/** Shared immutable empty list for the hot path. */
const EMPTY_ROOTS = Object.freeze([])
