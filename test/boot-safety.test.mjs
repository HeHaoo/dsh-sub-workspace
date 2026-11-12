/**
 * Boot-safety tests: `apply()` must NEVER throw.
 *
 * ## Why this file exists
 *
 * The first install crashed the whole DSH application. The cause was here:
 * cordis rethrows anything `apply()` throws:
 *
 *     try { task = this._execute(runner) }
 *     catch (reason) { ...; throw reason }        // cordis/lib/index.js
 *
 * The loader surfaces that at boot, so one plugin's activation error takes the
 * entire app down. A convenience feature must never be able to do that.
 *
 * These tests pin the contract: every degraded composition is tolerated, the
 * failure is reported (not silently swallowed), and the parts that CAN work
 * still work.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempHome = () => realpathSync.native(mkdtempSync(join(tmpdir(), 'subws-boot-')))

/** Run `apply` against a context, returning {threw, error, logs, status}. */
async function boot(ctx, home) {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const logs = { info: [], warn: [], error: [] }
  ctx.logger = {
    info: (m) => logs.info.push(String(m)),
    warn: (m) => logs.warn.push(String(m)),
    error: (m) => logs.error.push(String(m)),
  }
  let threw
  let status
  try {
    const { apply } = await import('../lib/index.js')
    apply(ctx)
    status = ctx.__status
  } catch (error) {
    threw = error
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
  return { threw, logs, status }
}

/** A context whose `provide` records the status object. */
function baseCtx(extra = {}) {
  const ctx = {
    effect: (callback) => {
      try {
        return callback()
      } catch {
        return undefined
      }
    },
    provide: (name, value) => {
      if (name === 'subWorkspaceStatus') ctx.__status = value
    },
    ...extra,
  }
  return ctx
}

test('an empty context never throws', async () => {
  const { threw, logs } = await boot(baseCtx(), tempHome())
  assert.equal(threw, undefined, 'apply() must never throw')
  assert.ok(logs.error.length + logs.warn.length > 0, 'degradation must be reported')
})

test('a missing sandboxPolicy degrades without throwing', async () => {
  const ctx = baseCtx({
    get: () => undefined,
    tools: { register: () => () => {} },
  })
  const { threw, logs } = await boot(ctx, tempHome())
  assert.equal(threw, undefined)
  assert.equal(ctx.__status?.decorated, false)
  assert.equal(ctx.__status?.tool, true, 'the tool can still register without decoration')
  assert.match(logs.error.join('\n'), /decoration/)
})

test('a sandboxPolicy whose resolve throws at decorate time degrades', async () => {
  const ctx = baseCtx({
    get: (key) =>
      key === 'sandboxPolicy'
        ? {
            resolve() {
              throw new Error('boom')
            },
          }
        : undefined,
    tools: { register: () => () => {} },
  })
  const { threw } = await boot(ctx, tempHome())
  assert.equal(threw, undefined, 'a throwing resolve must not fail the boot')
})

test('a broken tools registry degrades without throwing', async () => {
  const ctx = baseCtx({
    get: () => ({ resolve: () => ({ mode: 'workspace-write', workspaceRoot: '/x' }) }),
    // Faithful to cordis: `effect` runs the callback and lets its error escape.
    effect: (callback) => callback(),
    tools: {
      register() {
        throw new Error('tool registry exploded')
      },
    },
  })
  const { threw, logs } = await boot(ctx, tempHome())
  assert.equal(threw, undefined)
  assert.equal(ctx.__status?.decorated, true, 'decoration succeeded before the tool failed')
  assert.equal(ctx.__status?.tool, false)
  assert.match(logs.error.join('\n'), /tool/)
})

test('a throwing ctx.inject degrades without throwing', async () => {
  const ctx = baseCtx({
    get: (key) => (key === 'sandboxPolicy' ? { resolve: () => ({ mode: 'workspace-write', workspaceRoot: '/x' }) } : undefined),
    tools: { register: () => () => {} },
    inject: () => {
      throw new Error('inject unavailable')
    },
  })
  const { threw } = await boot(ctx, tempHome())
  assert.equal(threw, undefined)
})

test('a fully working context reports all three stages active', async () => {
  const resolveCalls = []
  const service = {
    resolve(request = {}) {
      resolveCalls.push(request)
      return { mode: 'workspace-write', workspaceRoot: '/ws/x', additionalWritableRoots: [] }
    },
  }
  let injected = 0
  const ctx = baseCtx({
    get: (key) => {
      if (key === 'sandboxPolicy') return service
      if (key === 'connection') return { fetch: { register: () => () => {} } }
      return undefined
    },
    tools: { register: () => () => {} },
    inject: (deps, callback) => {
      injected += 1
      callback(ctx)
    },
  })
  const { threw, logs } = await boot(ctx, tempHome())
  assert.equal(threw, undefined)
  assert.equal(ctx.__status?.decorated, true)
  assert.equal(ctx.__status?.tool, true)
  assert.equal(ctx.__status?.routes, true)
  assert.equal(injected, 1)
  // The decoration is live: the service now tolerates the affiliate field.
  const policy = service.resolve({ session: { header: { cwd: '/ws/x' } } })
  assert.equal(policy.mode, 'workspace-write')
  assert.match(logs.info.join('\n'), /active/)
})
