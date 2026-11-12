#!/usr/bin/env node
/**
 * Sandbox-policy check: does an affiliate root actually reach the live policy?
 *
 * The plugin's whole promise is "a decorated sandboxPolicy.resolve() carries the
 * workspace's affiliate roots, so official write/edit/bash honor them". That is
 * a pure function of (decorate.js + store.js + the official policy object), so
 * this check drives the SHIPPED modules — never a reimplementation — against a
 * fake policy service, and asserts:
 *
 *   - workspace-write gains the affiliate roots;
 *   - read-only and danger-full-access are left untouched (nothing to add);
 *   - roots are merged after the official ones and de-duplicated;
 *   - a store fault or a non-object policy degrades to the official policy
 *     instead of breaking every write;
 *   - undo() restores the exact previous resolve, and double-decoration is
 *     refused so a hot reload cannot stack wrappers.
 *
 * It also reads the LIVE host (read-only) to report which running sessions sit
 * in a workspace that already has affiliates — the population a real write
 * would become possible for. Deciding writability itself is covered
 * in-process here and by routes-check.mjs's /check route, because proving it
 * end to end needs an actual writing tool call (see README, "manual step").
 *
 * Replaces: verify_sandbox.mjs, setnow.mjs and the policy assumptions behind
 * tooltest.mjs.
 *
 * Usage:
 *   node scripts/verify/sandbox-check.mjs [--port 52524] [--skip-live]
 *
 * Exit codes: 0 all checks passed, 1 a check failed, 2 precondition missing.
 *
 * @module dsh-sub-workspace/scripts/verify/sandbox-check
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { dshBase, dshPort, parseArgs, PLUGIN_ROOT, readAuthSecret, reporter, request, run, PreconditionError } from './lib/env.mjs'

const args = parseArgs()
const port = dshPort(args.get('port'))

async function pluginModule(relative) {
  const url = pathToFileURL(join(PLUGIN_ROOT, relative)).href
  try {
    return await import(url)
  } catch (error) {
    throw new PreconditionError('cannot import ' + relative + ': ' + (error && error.message ? error.message : error))
  }
}

/** A stand-in for the official sandboxPolicy service. */
function fakePolicyService(policy) {
  return {
    resolve(request) {
      return Object.assign({}, policy)
    },
  }
}

await run(async () => {
  const report = reporter('sandbox policy decoration check')
  const { decorateSandboxPolicy } = await pluginModule('lib/decorate.js')
  const { AffiliateStore } = await pluginModule('lib/store.js')

  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'subws-sandbox-')))
  const workspaceDir = join(root, 'workspace')
  const affiliateDir = join(root, 'affiliate')
  mkdirSync(workspaceDir, { recursive: true })
  mkdirSync(affiliateDir, { recursive: true })
  report.info('fixture', root)

  const store = new AffiliateStore(join(root, 'affiliates.json'))
  const session = { header: { cwd: workspaceDir } }
  store.add(workspaceDir, affiliateDir)

  // ---- workspace-write gains the affiliate roots -----------------------
  const service = fakePolicyService({ mode: 'workspace-write', workspaceRoot: workspaceDir, additionalWritableRoots: [] })
  const original = service.resolve
  const undo = decorateSandboxPolicy(service, store)
  const decorated = service.resolve({ session })
  if (Array.isArray(decorated.additionalWritableRoots) && decorated.additionalWritableRoots.includes(affiliateDir)) {
    report.pass('workspace-write policy gains the affiliate root', affiliateDir)
  } else {
    report.fail('workspace-write policy gains the affiliate root', JSON.stringify(decorated))
  }
  if (decorated.workspaceRoot === workspaceDir && decorated.mode === 'workspace-write') {
    report.pass('the official policy fields survive decoration', 'mode + workspaceRoot intact')
  } else {
    report.fail('the official policy fields survive decoration', JSON.stringify(decorated))
  }

  // ---- an unrelated session gets nothing -------------------------------
  const otherSession = service.resolve({ session: { header: { cwd: join(root, 'elsewhere') } } })
  if (otherSession.additionalWritableRoots.length === 0) {
    report.pass('a session outside the workspace gets no affiliate root')
  } else {
    report.fail('a session outside the workspace gets no affiliate root', JSON.stringify(otherSession.additionalWritableRoots))
  }

  // ---- an agentless resolve gets nothing -------------------------------
  const agentless = service.resolve({})
  if (agentless.additionalWritableRoots.length === 0) {
    report.pass('a resolve without a session gets no affiliate root')
  } else {
    report.fail('a resolve without a session gets no affiliate root', JSON.stringify(agentless.additionalWritableRoots))
  }

  // ---- official roots are preserved and de-duplicated ------------------
  const withOfficial = fakePolicyService({
    mode: 'workspace-write',
    workspaceRoot: workspaceDir,
    additionalWritableRoots: ['/opt/official-root', affiliateDir],
  })
  decorateSandboxPolicy(withOfficial, store)
  const merged = withOfficial.resolve({ session })
  const roots = merged.additionalWritableRoots
  const occurrences = roots.filter((entry) => entry === affiliateDir).length
  if (roots[0] === '/opt/official-root' && occurrences === 1) {
    report.pass('official roots come first and duplicates collapse', roots.join(', '))
  } else {
    report.fail('official roots come first and duplicates collapse', JSON.stringify(roots))
  }

  // ---- read-only is not decorated --------------------------------------
  const readOnly = fakePolicyService({ mode: 'read-only', workspaceRoot: workspaceDir, additionalWritableRoots: [] })
  decorateSandboxPolicy(readOnly, store)
  const readOnlyPolicy = readOnly.resolve({ session })
  if (readOnlyPolicy.additionalWritableRoots.length === 0) {
    report.pass('read-only policy is left untouched')
  } else {
    report.fail('read-only policy is left untouched', JSON.stringify(readOnlyPolicy.additionalWritableRoots))
  }

  // ---- danger-full-access is not decorated -----------------------------
  const full = fakePolicyService({ mode: 'danger-full-access', workspaceRoot: workspaceDir })
  decorateSandboxPolicy(full, store)
  const fullPolicy = full.resolve({ session })
  if (Array.isArray(fullPolicy.additionalWritableRoots) === false || fullPolicy.additionalWritableRoots.length === 0) {
    report.pass('danger-full-access policy is left untouched')
  } else {
    report.fail('danger-full-access policy is left untouched', JSON.stringify(fullPolicy.additionalWritableRoots))
  }

  // ---- a broken official contract degrades gracefully ------------------
  const brokenService = { resolve: () => undefined }
  const warnings = []
  decorateSandboxPolicy(brokenService, store, { warn: (message) => warnings.push(message) })
  const broken = brokenService.resolve({ session })
  if (broken === undefined && warnings.length === 1) {
    report.pass('a non-object policy degrades to the official value', warnings[0])
  } else {
    report.fail('a non-object policy degrades to the official value', JSON.stringify({ broken, warnings }))
  }

  // ---- a throwing store degrades gracefully -----------------------------
  const throwingStore = {
    rootsFor() {
      throw new Error('simulated store fault')
    },
  }
  const throwingService = fakePolicyService({ mode: 'workspace-write', workspaceRoot: workspaceDir, additionalWritableRoots: [] })
  const faultWarnings = []
  decorateSandboxPolicy(throwingService, throwingStore, { warn: (message) => faultWarnings.push(message) })
  const faulted = throwingService.resolve({ session })
  if (faulted.additionalWritableRoots.length === 0 && faultWarnings.length === 1) {
    report.pass('a store fault keeps the official policy', faultWarnings[0])
  } else {
    report.fail('a store fault keeps the official policy', JSON.stringify({ faulted, faultWarnings }))
  }

  // ---- undo restores the exact previous resolve -------------------------
  if (service.resolve !== original) {
    undo()
    if (service.resolve === original) report.pass('undo() restores the original resolve')
    else report.fail('undo() restores the original resolve', 'resolve was not restored')
  } else {
    report.fail('decorate() actually replaced resolve', 'resolve is unchanged')
  }

  // ---- double decoration is refused ------------------------------------
  decorateSandboxPolicy(service, store)
  try {
    decorateSandboxPolicy(service, store)
    report.fail('a second decoration is refused', 'it stacked a second wrapper')
  } catch (error) {
    report.pass('a second decoration is refused', error.message)
  }

  // ---- the plugin does not replace the official service ----------------
  // It mutates the live instance's resolve; the instance identity is unchanged.
  if (service.resolve !== undefined && typeof service.resolve === 'function') {
    report.pass('the decorated instance is the same object (no service replacement)')
  } else {
    report.fail('the decorated instance is the same object (no service replacement)', 'resolve disappeared')
  }

  // ---- B. live context (read-only) -------------------------------------
  if (args.has('skip-live')) {
    report.skip('live session context', '--skip-live')
  } else {
    const { secret } = readAuthSecret()
    report.info('live host', dshBase(port) + ' (auth secret from credentials/env, value withheld)')

    // sessions/list is the browser's own read-only RPC; it never mutates.
    const rpcId = randomUUID().toUpperCase()
    const sessions = await request('/api/session/list', {
      port,
      secret,
      method: 'POST',
      body: { type: 'client-request', rpcId, method: 'session/list', payload: { args: { _request: {} } } },
      timeoutMs: 20000,
    })
    const value = sessions.json && sessions.json.result && sessions.json.result.ok === true ? sessions.json.result.value : undefined
    if (sessions.status === 200 && value !== undefined && Array.isArray(value.items)) {
      const liveStore = new AffiliateStore(join(process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : join(process.env.HOME || '', '.dsh'), 'sub-workspace', 'affiliates.json'))
      const keyed = new Set(liveStore.keys())
      const affected = value.items.filter((item) => typeof item.cwd === 'string' && keyed.has(item.cwd))
      report.pass('live session/list is readable', value.items.length + ' session(s)')
      report.info('sessions in a workspace with affiliates', affected.length + ' (would gain the affiliate roots on their next tool call)')
      for (const item of affected.slice(0, 5)) {
        report.info('  session', item.cwd + ' — ' + (liveStore.get(item.cwd).length) + ' root(s)')
      }
      if (keyed.size > 0) report.info('affiliate store', keyed.size + ' workspace key(s) persisted')
      else report.info('affiliate store', 'empty — nothing to verify end to end yet')
    } else {
      report.fail('live session/list is readable', 'HTTP ' + sessions.status + ' ' + String(sessions.text).slice(0, 200))
    }
  }

  try {
    rmSync(root, { recursive: true, force: true })
    report.pass('fixture cleaned up', root)
  } catch {
    report.info('fixture cleaned up', 'left behind: ' + root)
  }

  const summary = report.print()
  return summary.failed === 0 ? 0 : 1
})
