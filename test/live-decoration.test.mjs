/**
 * LIVE decoration integration test: real cordis + the real `lib/index.js`
 * activation path + a consumer in an INDEPENDENT fiber.
 *
 * ## Why this file exists
 *
 * Bug 2 ("adding an affiliate to a running session does not take effect") had a
 * root cause the unit tests could never see, because they call
 * `decorateSandboxPolicy(fakeService, ...)` with a plain object literal. In a
 * real host that argument is a cordis **tracing Proxy** (`createTraceable`),
 * and the Proxy is not identity-transparent:
 *
 *   - `proxy.resolve` returns a fresh `createShadowMethod` wrapper on every
 *     access, so `proxy.resolve === anything` is always false;
 *   - `proxy.resolve = fn` DOES reach the raw instance (verified on cordis
 *     4.0.5), so the write "worked" and the comparison "failed".
 *
 * The old code decorated through the Proxy and compared identity through the
 * Proxy. Consequences, all reproduced below:
 *
 *   1. undo()'s guard `if (service.resolve === decorated)` was never true, so
 *      teardown silently did nothing — the wrapper and the DECORATED marker
 *      stayed on the raw instance;
 *   2. the next activation therefore failed with "already decorated; refusing
 *      to stack wrappers". `apply()` catches that (boot safety) and degrades,
 *      leaving the FIRST activation's store closure in place forever;
 *   3. roots the user added afterwards went to disk and were reported by
 *      `/api/sub-workspace/list`, but the live `resolve()` kept consulting the
 *      stale store — "store has it, the sandbox never does".
 *
 * ## What this test pins
 *
 * Using the real `@deepseek-ai/cordis` from the installed DSH profile:
 *   1. a consumer in another fiber sees the affiliate root after decoration;
 *   2. `store.add()` is visible to the consumer's VERY NEXT `resolve()`;
 *   3. teardown restores the service exactly (own-property shape included), so
 *      a later activation is allowed to decorate again;
 *   4. decoration still works when `cordis.original` is unavailable
 *      (degradation path), so a host change cannot disable the feature.
 *
 * Skipped (with a clear message) when the installed cordis is not present,
 * so the suite still runs on a machine without a DSH profile.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Resolve the real cordis installation from the desktop DSH profile. */
function cordisEntry() {
  const candidates = [
    process.env.DSH_CORDIS_ENTRY,
    join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js'),
    join(homedir(), '.dsh', 'profiles', 'default', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js'),
  ].filter((candidate) => typeof candidate === 'string' && candidate !== '')
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return undefined
}

const CORDIS = cordisEntry()
const skip = CORDIS === undefined ? 'real @deepseek-ai/cordis is not installed in a DSH profile' : false

/** Load the real cordis module (Context + Service) once. */
let cordisModule
async function loadCordis() {
  if (cordisModule === undefined) cordisModule = await import(pathToFileURL(CORDIS).href)
  return cordisModule
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

const tempDir = () => realpathSync.native(mkdtempSync(join(tmpdir(), 'subws-live-')))

/**
 * Run `fn` with `$DSH_HOME` pointed at a throwaway directory, restoring the
 * previous value afterwards. The plugin resolves its store path from DSH_HOME
 * at activation, so every activation in this file must run inside this scope —
 * otherwise a test would read (and try to write!) the developer's real
 * `~/.dsh/sub-workspace/affiliates.json`.
 */
async function withHome(fn) {
  const home = tempDir()
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await fn(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
}

/**
 * Build a fresh app with a `sandboxPolicy` service shaped like the official
 * `SandboxPolicyService`: it extends cordis `Service`, self-registers under the
 * name in its constructor, inherits `resolve` from its prototype (so the
 * own-property bookkeeping in undo() is exercised for real), and returns the
 * official field set.
 */
async function buildApp({ home, mode = 'workspace-write' } = {}) {
  const { Context, Service } = await loadCordis()
  const app = new Context()
  app.logger.exporter = () => {}

  class FakeSandboxPolicy extends Service {
    constructor(ctx) {
      super(ctx, 'sandboxPolicy')
      this.defaultMode = mode
      this.workspaceRoot = '/deployment/fallback'
      this.additionalWritableRoots = ['/deployment/only']
    }
    // Inherited, NOT an own property — matches the official class.
    resolve(request = {}) {
      const { session } = request ?? {}
      return {
        mode: this.defaultMode,
        workspaceRoot: session?.header?.cwd ?? this.workspaceRoot,
        additionalWritableRoots: [...this.additionalWritableRoots],
        ...(session === undefined ? {} : { sessionId: session.id }),
      }
    }
  }

  await app.plugin({ name: 'sandbox-policy', apply (ctx) { new FakeSandboxPolicy(ctx) } })
  await tick()

  const tools = []
  await app.plugin({
    name: 'tools',
    apply (ctx) { ctx.provide('tools', { register: (definition) => { tools.push(definition); return () => {} } }) },
  })
  await app.plugin({
    name: 'workspace-registry',
    apply (ctx) { ctx.provide('workspaceRegistry', { list: () => [] }) },
  })
  await tick()

  return { app, tools, home }
}

/** Import the plugin's real activation entrypoint. */
const pluginEntry = pathToFileURL(join(import.meta.dirname, '..', 'lib', 'index.js')).href

/**
 * Activate the REAL plugin (lib/index.js) on this app, exactly like a profile
 * row does: the loader awaits the fiber, so `apply()` runs synchronously inside
 * a plugin lifecycle with `inject` satisfied.
 *
 * `apply()` builds its `AffiliateStore` from `storeFile()`, which reads
 * `$DSH_HOME` at activation time — so the caller must have pointed DSH_HOME at
 * its temp home already, and must leave it there for the rest of the test.
 */
async function activatePlugin(app) {
  const plugin = await import(pluginEntry)
  const fiber = app.plugin({ name: 'sub-workspace', inject: plugin.inject, apply: (ctx) => plugin.apply(ctx) })
  await fiber
  await tick(40)
  return { plugin, fiber }
}

/** Mount a consumer in its OWN fiber — this is the whole point of the test. */
async function consumerCtx(app) {
  let seen
  await app.plugin({ name: 'consumer', inject: ['sandboxPolicy'], apply (ctx) { seen = ctx } })
  await tick()
  assert.notEqual(seen, undefined, 'the consumer fiber must activate')
  return seen
}

const session = (cwd) => ({ id: 's-live', header: { cwd } })
const affiliateRoots = (ctx, cwd) => ctx.sandboxPolicy.resolve({ session: session(cwd) }).additionalWritableRoots ?? []

test('BUG2: decoration is visible to a consumer in an independent fiber', { skip }, async () => {
  await withHome(async (home) => {
    const { app } = await buildApp({ home })
    const consumer = await consumerCtx(app)

    // Before activation: only the deployment root.
    assert.deepEqual(affiliateRoots(consumer, '/ws/mine'), ['/deployment/only'])

    await activatePlugin(app)
    const status = app.get('subWorkspaceStatus')
    assert.equal(status?.decorated, true, 'the decoration must be live')
    assert.equal(status?.serviceSource, 'unwrapped', 'a cordis Proxy must be unwrapped to the raw instance')

    // The plugin's OWN store is what the decoration reads. Writing through a
    // second instance is realistic (the panel's route activation), and the
    // mtime refresh is what makes it visible.
    const store = join(home, 'sub-workspace', 'affiliates.json')
    const { AffiliateStore } = await import(pathToFileURL(join(import.meta.dirname, '..', 'lib', 'store.js')).href)
    // A real directory under the test's own temp home: the assertion must not
    // depend on any particular developer's filesystem layout.
    const affiliate = join(home, 'affiliate-root')
    mkdirSync(affiliate, { recursive: true })
    new AffiliateStore(store).add('/ws/mine', affiliate)
    await tick(1100)

    const policy = consumer.sandboxPolicy.resolve({ session: session('/ws/mine') })
    assert.ok(
      policy.additionalWritableRoots.includes(affiliate),
      'a consumer fiber must see the affiliate root through the decorated resolve()',
    )
    // Official facts must survive untouched.
    assert.equal(policy.mode, 'workspace-write')
    assert.equal(policy.workspaceRoot, '/ws/mine')
    assert.equal(policy.sessionId, 's-live')
    assert.ok(policy.additionalWritableRoots.includes('/deployment/only'), 'the deployment root must be preserved')
  })
})

test('BUG2: store.add() takes effect on the consumer VERY NEXT resolve()', { skip }, async () => {
  await withHome(async (home) => {
    const { app, tools } = await buildApp({ home })
    const consumer = await consumerCtx(app)
    await activatePlugin(app)

    const tool = tools[0]
    assert.equal(tool?.name, 'sub_workspace', 'the real tool must be registered')

    const exec = { agent: { session: session('/ws/mine') } }
    const read = () => consumer.sandboxPolicy.resolve({ session: session('/ws/mine') }).additionalWritableRoots

    const affiliate = tempDir()
    try {
      assert.ok(!read().includes(affiliate), 'sanity: not an affiliate yet')

      const added = await tool.execute({ action: 'add', path: affiliate }, exec)
      assert.ok(added.mine.includes(affiliate))

      // THE assertion for bug 2: no restart, no reload, no sleep — the very
      // next resolve() the prompt/tool path performs must carry the new root.
      assert.ok(
        read().includes(affiliate),
        'adding an affiliate must be visible to the immediately following resolve()',
      )

      // And removal is symmetric.
      await tool.execute({ action: 'remove', path: affiliate }, exec)
      assert.ok(!read().includes(affiliate), 'removal must be visible immediately too')
    } finally {
      rmSync(affiliate, { recursive: true, force: true })
    }
  })
})

test('BUG2: teardown restores the service EXACTLY so a reload can re-decorate', { skip }, async () => {
  await withHome(async (home) => {
    const { app } = await buildApp({ home })
    const consumer = await consumerCtx(app)
    const ORIGINAL = Symbol.for('cordis.original')
    const DECORATED = Symbol.for('dsh-sub-workspace.decorated')
    const raw = app.get('sandboxPolicy')[ORIGINAL]

    const prototypeResolve = Object.getPrototypeOf(raw).resolve
    assert.equal(Object.hasOwn(raw, 'resolve'), false, 'the fake service inherits resolve, like the official one')

    const { fiber } = await activatePlugin(app)
    assert.equal(Object.hasOwn(raw, 'resolve'), true, 'decoration must create an own resolve on the raw instance')
    assert.equal(raw[DECORATED], true)

    // Dispose the plugin fiber, the way cordis unloads a row. `app.plugin()`
    // returns the fiber itself; `registry.get` is keyed by callback, not name.
    assert.notEqual(fiber, undefined, 'app.plugin() must return the plugin fiber')
    await fiber.dispose()
    await tick(80)

    // Exact restore is what makes re-decoration possible at all.
    assert.equal(Object.hasOwn(raw, 'resolve'), false, 'undo must delete the own property it created')
    assert.equal(raw.resolve, prototypeResolve, 'undo must restore the inherited method')
    assert.equal(raw[DECORATED], undefined, 'undo must clear the marker')

    // Roots added while unmounted must be visible after re-activation: the old
    // code was frozen on the first activation's store forever.
    const store = join(home, 'sub-workspace', 'affiliates.json')
    const { AffiliateStore } = await import(pathToFileURL(join(import.meta.dirname, '..', 'lib', 'store.js')).href)
    new AffiliateStore(store).add('/ws/mine', '/second/root')

    await activatePlugin(app)
    await tick(50)
    assert.ok(
      consumer.sandboxPolicy.resolve({ session: session('/ws/mine') }).additionalWritableRoots.includes('/second/root'),
      'a re-activation must pick up roots added while it was unmounted (no stale-store freeze)',
    )
  })
})

test('BUG2: decoration still works when cordis.original is unavailable (degradation)', { skip }, async () => {
  const { decorateSandboxPolicy, unwrapService } = await import(
    pathToFileURL(join(import.meta.dirname, '..', 'lib', 'decorate.js')).href
  )
  // A plain object with NO cordis.original symbol: unwrapService must fall back
  // to the object itself rather than refusing to decorate.
  const service = {
    resolve: () => ({ mode: 'workspace-write', workspaceRoot: '/ws/x', additionalWritableRoots: [] }),
  }
  assert.equal(unwrapService(service), service, 'a non-traceable service must be used as-given')

  const store = { rootsFor: () => ['/affiliate/degraded'] }
  const undo = decorateSandboxPolicy(service, store)
  const policy = service.resolve({ session: session('/ws/x') })
  assert.deepEqual(policy.additionalWritableRoots, ['/affiliate/degraded'])

  undo()
  assert.deepEqual(service.resolve({}), { mode: 'workspace-write', workspaceRoot: '/ws/x', additionalWritableRoots: [] })
})

test('BUG2: decorating a cordis PROXY targets the raw instance (marker lives there)', { skip }, async () => {
  const { decorateSandboxPolicy } = await import(
    pathToFileURL(join(import.meta.dirname, '..', 'lib', 'decorate.js')).href
  )
  await withHome(async (home) => {
    const { app } = await buildApp({ home })
    const proxy = app.get('sandboxPolicy')
    const ORIGINAL = Symbol.for('cordis.original')
    const raw = proxy[ORIGINAL]
    assert.notEqual(raw, undefined, 'cordis must expose the raw instance on its tracing Proxy')
    assert.notEqual(proxy.resolve, raw.resolve, 'proxy method identity is not stable (the original bug)')

    const undo = decorateSandboxPolicy(proxy, { rootsFor: () => ['/x/affiliate'] })

    // The wrapper must be an OWN property of the RAW instance, not of the Proxy.
    assert.equal(Object.hasOwn(raw, 'resolve'), true, 'the wrapper must land on the raw instance')

    // Idempotence is keyed on the raw instance, so a second decorate refuses.
    assert.throws(() => decorateSandboxPolicy(proxy, { rootsFor: () => [] }), /already decorated/)

    undo()
    assert.equal(Object.hasOwn(raw, 'resolve'), false, 'undo must delete the own property it created')
    assert.equal(raw.resolve, Object.getPrototypeOf(raw).resolve, 'undo must restore the inherited method')
    // After a correct undo, decorating again is allowed.
    assert.doesNotThrow(() => decorateSandboxPolicy(proxy, { rootsFor: () => [] }))
  })
})

test('BUG2: a hand-edited affiliates.json is picked up by the hot path (mtime refresh)', { skip }, async () => {
  const { AffiliateStore } = await import(pathToFileURL(join(import.meta.dirname, '..', 'lib', 'store.js')).href)
  await withHome(async (home) => {
    const file = join(home, 'affiliates.json')
    writeFileSync(file, JSON.stringify({ version: 1, workspaces: {} }), 'utf8')
    const store = new AffiliateStore(file)
    const request = { session: session('/ws/mine') }
    assert.deepEqual(store.rootsFor(request), [])

    // Simulate the user editing the document by hand (the documented workflow).
    writeFileSync(file, JSON.stringify({ version: 1, workspaces: { '/ws/mine': ['/hand/edited'] } }), 'utf8')
    // Defeat mtime granularity so the change is always detectable.
    const future = new Date(Date.now() + 2000)
    utimesSync(file, future, future)

    await tick(1100) // past the rate-limited freshness window
    assert.deepEqual(
      store.rootsFor(request),
      ['/hand/edited'],
      'a hand-edited document must become effective without a restart',
    )
  })
})
test('BUG2b: /api/sub-workspace/check resolves the WORKSPACE policy, not an agentless one', async () => {
  const { installRoutes, ROUTE_CHECK } = await import(
    pathToFileURL(join(import.meta.dirname, '..', 'lib', 'routes.js')).href
  )
  const registered = []
  const connection = { fetch: { register: (route) => { registered.push(route); return () => {} } } }
  const workspace = tempDir()
  const inside = join(workspace, 'child')
  mkdirSync(inside)
  const affiliate = tempDir()
  const outside = tempDir()

  // The policy resolver behaves like the real decorated resolve(): the session
  // cwd is the boundary and the affiliate root is an extra writable root.
  const resolvePolicy = (request = {}) => ({
    mode: 'workspace-write',
    workspaceRoot: request.session?.header?.cwd ?? '/deployment/fallback',
    additionalWritableRoots: [affiliate],
  })
  installRoutes({
    store: { keys: () => [], get: () => [] },
    resolvePolicy,
    storePath: join(workspace, 'affiliates.json'),
    connection,
    workspaceRegistry: undefined,
  })
  const route = registered.find((entry) => entry.path === ROUTE_CHECK)
  assert.notEqual(route, undefined, 'the check route must be registered')
  const call = async (query) => (await route.fetch(new Request('http://127.0.0.1' + ROUTE_CHECK + query))).json()

  // THE BUG: with no session, even the workspace root reported "not writable".
  const agentless = await call('?path=' + encodeURIComponent(inside))
  assert.equal(agentless.writable, false, 'without a workspace the answer is the agentless policy (unchanged behaviour)')
  assert.match(String(agentless.hint), /workspace/, 'it must say how to get a real answer')

  // With the workspace given, the same path is inside the boundary.
  const scoped = await call('?path=' + encodeURIComponent(inside) + '&workspace=' + encodeURIComponent(workspace))
  assert.equal(scoped.writable, true, 'a path under the workspace root must be writable once the workspace is supplied')
  assert.ok(scoped.matchedRoot !== undefined)

  // An affiliate root is writable in that workspace's policy.
  const affiliateHit = await call('?path=' + encodeURIComponent(affiliate) + '&workspace=' + encodeURIComponent(workspace))
  assert.equal(affiliateHit.writable, true, 'an affiliate root must be writable')
  assert.equal(affiliateHit.matchedRoot, affiliate)

  // An unrelated directory is not.
  const miss = await call('?path=' + encodeURIComponent(outside) + '&workspace=' + encodeURIComponent(workspace))
  assert.equal(miss.writable, false)
  assert.equal(miss.reason, 'not under any writable root')

  // A non-absolute workspace is refused, not silently accepted.
  const bad = await call('?path=' + encodeURIComponent(inside) + '&workspace=relative/path')
  assert.equal(bad.writable, false)
  assert.match(String(bad.reason), /absolute/)

  rmSync(workspace, { recursive: true, force: true })
  rmSync(affiliate, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})
