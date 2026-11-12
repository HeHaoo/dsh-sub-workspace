/**
 * Activation smoke test with a minimal stand-in cordis context.
 *
 * This proves `apply()` wires the decoration and registers the tool against the
 * REAL contracts we read from the shipped packages:
 *   - `ctx.effect(callback)` — callback runs, its return value is the disposer;
 *   - `ctx.get('sandboxPolicy')` — the live service;
 *   - `ctx.tools.register(definition)` — returns the disposer.
 *
 * It is not a substitute for loading the plugin in a live DSH host; it catches
 * wiring mistakes (wrong disposer shape, decoration ordering, tool contract).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, inject, name } from '../lib/index.js'
import { canonicalPath } from '../lib/paths.js'

const tempDir = () => realpathSync.native(mkdtempSync(join(tmpdir(), 'subws-apply-')))

/** Build a fake ctx recording effects and tool registrations. */
function fakeCtx(service, home) {
  const effects = []
  const registered = []
  const infos = []
  const warnings = []
  return {
    effects,
    registered,
    infos,
    warnings,
    ctx: {
      get: (key) => (key === 'sandboxPolicy' ? service : undefined),
      effect: (callback, label) => {
        const disposer = callback()
        effects.push({ label, disposer })
        return disposer
      },
      tools: {
        register: (definition) => {
          registered.push(definition)
          return () => {
            const at = registered.indexOf(definition)
            if (at !== -1) registered.splice(at, 1)
          }
        },
      },
      logger: {
        info: (m) => infos.push(m),
        warn: (m) => warnings.push(m),
      },
    },
  }
}

function fakeService() {
  return {
    defaultMode: 'workspace-write',
    workspaceRoot: '/fallback',
    resolve(request = {}) {
      return {
        mode: 'workspace-write',
        workspaceRoot: request.session?.header?.cwd ?? '/fallback',
        additionalWritableRoots: ['/deployment/only'],
        ...(request.session === undefined ? {} : { sessionId: request.session.id }),
      }
    },
  }
}

test('apply() decorates the policy and registers exactly one tool', () => {
  const home = tempDir()
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const service = fakeService()
    const harness = fakeCtx(service, home)
    apply(harness.ctx)

    assert.equal(inject.includes('sandboxPolicy'), true)
    assert.equal(name, 'sub-workspace')

    // Two effects: the decoration restore, and the tool registration.
    assert.equal(harness.effects.length, 2)
    assert.match(harness.effects[0].label, /sandboxPolicy/)
    assert.match(harness.effects[1].label, /sub_workspace tool/)

    assert.equal(harness.registered.length, 1)
    const tool = harness.registered[0]
    assert.equal(tool.name, 'sub_workspace')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
    assert.ok(tool.output.schema)

    // The service is decorated: resolve now tolerates the added field.
    const policy = service.resolve({ session: { id: 's1', header: { cwd: '/ws/one' } } })
    assert.equal(policy.mode, 'workspace-write')
    assert.deepEqual(policy.additionalWritableRoots, ['/deployment/only'])
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('the registered tool manages affiliates end to end', async () => {
  const home = tempDir()
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const affiliate = tempDir()
    const other = tempDir()
    const service = fakeService()
    const harness = fakeCtx(service, home)
    apply(harness.ctx)
    const tool = harness.registered[0]

    const exec = { agent: { session: { id: 's1', header: { cwd: '/ws/mine' } } } }

    // Initially nothing.
    let listed = await tool.execute({ action: 'list' }, exec)
    assert.deepEqual(listed.mine, [])

    // check: outside the boundary.
    let checked = await tool.execute({ action: 'check', path: affiliate }, exec)
    assert.equal(checked.writable, false)

    // add, then the very next resolve() must already allow it.
    const added = await tool.execute({ action: 'add', path: affiliate }, exec)
    assert.deepEqual(added.mine, [affiliate])
    assert.ok(
      service.resolve({ session: exec.agent.session }).additionalWritableRoots.includes(affiliate),
      'adding an affiliate must be visible to the next resolve()',
    )

    // check now passes and reports the root that matched.
    checked = await tool.execute({ action: 'check', path: affiliate }, exec)
    assert.equal(checked.writable, true)
    assert.equal(checked.matchedRoot, affiliate)

    // A different workspace must not inherit it.
    const otherExec = { agent: { session: { id: 's2', header: { cwd: '/ws/other' } } } }
    const otherPolicy = service.resolve({ session: otherExec.agent.session })
    assert.ok(!otherPolicy.additionalWritableRoots.includes(affiliate))

    // set replaces wholesale.
    const set = await tool.execute({ action: 'set', paths: [other] }, exec)
    assert.deepEqual(set.mine, [other])
    assert.ok(!service.resolve({ session: exec.agent.session }).additionalWritableRoots.includes(affiliate))

    // remove drops it.
    const removed = await tool.execute({ action: 'remove', path: other }, exec)
    assert.deepEqual(removed.mine, [])

    // list reflects persisted state.
    listed = await tool.execute({ action: 'list' }, exec)
    assert.equal(listed.storePath.startsWith(home), true)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('the tool refuses a symlinked affiliate with an actionable message', async () => {
  const home = tempDir()
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { symlinkSync } = await import('node:fs')
    const real = tempDir()
    const linkParent = tempDir()
    const link = join(linkParent, 'ln')
    symlinkSync(real, link)

    const harness = fakeCtx(fakeService(), home)
    apply(harness.ctx)
    const tool = harness.registered[0]
    const exec = { agent: { session: { id: 's1', header: { cwd: '/ws/mine' } } } }

    await assert.rejects(() => tool.execute({ action: 'add', path: link }, exec), /physical path, not a symlink/)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('unmounting restores the official resolve exactly', () => {
  const home = tempDir()
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const service = fakeService()
    const harness = fakeCtx(service, home)
    apply(harness.ctx)

    const request = { session: { id: 's1', header: { cwd: '/ws/one' } } }
    const decoratedValue = service.resolve(request)
    assert.equal(canonicalPath(decoratedValue.workspaceRoot), '/ws/one')

    // Run the disposers in reverse, like cordis teardown.
    for (const entry of [...harness.effects].reverse()) entry.disposer()
    assert.deepEqual(service.resolve(request), {
      mode: 'workspace-write',
      workspaceRoot: '/ws/one',
      additionalWritableRoots: ['/deployment/only'],
      sessionId: 's1',
    })
    assert.equal(harness.registered.length, 0)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})
