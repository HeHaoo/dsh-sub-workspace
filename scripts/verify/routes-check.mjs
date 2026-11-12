#!/usr/bin/env node
/**
 * Route-contract check for the plugin's three host routes.
 *
 * Two layers, both real:
 *
 *   A. IN-PROCESS round-trip (no host needed): import the shipped lib/routes.js
 *      and lib/store.js, register the routes against a throwaway store in the
 *      OS temp dir with a fake connection + workspace registry, then drive
 *      list / mutate / check exactly like the browser half does. This is the
 *      only place the mutating paths are exercised, and it never touches the
 *      real affiliate store or ~/.dsh.
 *
 *   B. LIVE probes against the running DSH: the routes must be authenticated
 *      (401 without the cookie) and must reject a malformed mutate body with
 *      400 and no state change.
 *
 * Replaces: unit.mjs, tooltest.mjs, probe.mjs, check.mjs and the "does mutate
 * work without the registry" investigations.
 *
 * Usage:
 *   node scripts/verify/routes-check.mjs [--port 52524] [--skip-live]
 *
 * Exit codes: 0 all checks passed, 1 a check failed, 2 precondition missing.
 *
 * @module dsh-sub-workspace/scripts/verify/routes-check
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { dshBase, dshPort, PLUGIN_ROOT, parseArgs, readAuthSecret, reporter, request, run, PreconditionError } from './lib/env.mjs'
import { ROUTE_CHECK, ROUTE_LIST, ROUTE_MUTATE } from './lib/api.mjs'

const args = parseArgs()
const port = dshPort(args.get('port'))
const skipLive = args.has('skip-live')

/** Import one of the plugin's own modules (read-only reuse, never a copy). */
async function pluginModule(relative) {
  const url = pathToFileURL(join(PLUGIN_ROOT, relative)).href
  try {
    return await import(url)
  } catch (error) {
    throw new PreconditionError('cannot import ' + relative + ' from ' + PLUGIN_ROOT + ': ' + (error && error.message ? error.message : error))
  }
}

/** Decode a route Response the way the browser would. */
async function readResponse(response) {
  const text = await response.text()
  let json
  try {
    json = text === '' ? undefined : JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: response.status, text, json }
}

/**
 * Build a throwaway fixture under the OS temp dir: a store path, a "workspace"
 * directory and an "affiliate" directory. Both directories are real physical
 * dirs (validateRoot rejects symlinks and non-directories).
 */
function makeFixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'subws-routes-')))
  const workspaceDir = join(root, 'workspace')
  const affiliateDir = join(root, 'affiliate')
  mkdirSync(workspaceDir, { recursive: true })
  mkdirSync(affiliateDir, { recursive: true })
  return { root, workspaceDir, affiliateDir }
}

await run(async () => {
  const report = reporter('route contract check')
  const { AffiliateStore } = await pluginModule('lib/store.js')
  const { installRoutes } = await pluginModule('lib/routes.js')
  const { validateRoot } = await pluginModule('lib/paths.js')

  const fixture = makeFixture()
  const storePath = join(fixture.root, 'affiliates.json')
  const store = new AffiliateStore(storePath)

  // A fake host registry: two workspaces, one of which has no affiliates yet.
  const registry = {
    list: () => [
      { id: 'id-alpha', path: fixture.workspaceDir, title: 'alpha' },
      { id: 'id-ghost', path: join(fixture.root, 'ghost'), title: 'ghost' },
    ],
  }
  const registered = new Map()
  const connection = {
    fetch: {
      register(route) {
        registered.set(route.path, route)
        return () => registered.delete(route.path)
      },
    },
  }
  // The live decoration is replaced by a fixed policy here: this check is about
  // the ROUTE contract, sandbox-check.mjs covers the decoration itself.
  const resolvePolicy = () => ({ mode: 'workspace-write', workspaceRoot: fixture.workspaceDir, additionalWritableRoots: [] })
  installRoutes({ store, resolvePolicy, storePath, connection, workspaceRegistry: registry })

  report.info('fixture', fixture.root)
  for (const route of [ROUTE_LIST, ROUTE_MUTATE, ROUTE_CHECK]) {
    if (registered.has(route)) report.pass('route registered ' + route)
    else report.fail('route registered ' + route, 'not registered')
  }

  const call = async (path, init) => {
    const route = registered.get(path.split('?')[0])
    if (route === undefined) throw new Error('route not registered: ' + path)
    const request_ = new Request('http://127.0.0.1' + path, init)
    return readResponse(await route.fetch(request_))
  }

  // ---- list: an empty store still publishes registry workspaces ----------
  const empty = await call(ROUTE_LIST)
  const emptyKnown = Array.isArray(empty.json?.workspaces) ? empty.json.workspaces : []
  if (empty.status === 200) report.pass('list returns 200 on an empty store')
  else report.fail('list returns 200 on an empty store', 'HTTP ' + empty.status)
  if (emptyKnown.length === 2 && emptyKnown.every((item) => item.roots.length === 0)) {
    report.pass('list publishes registry workspaces with empty roots', emptyKnown.length + ' entries')
  } else {
    report.fail('list publishes registry workspaces with empty roots', JSON.stringify(empty.json))
  }
  if (empty.json?.registry === 'ok') report.pass('list reports registry=ok')
  else report.fail('list reports registry=ok', JSON.stringify(empty.json?.registry))

  // ---- list: id/title mapping is published for the sidebar --------------
  const alpha = emptyKnown.find((item) => item.workspace === fixture.workspaceDir)
  if (alpha !== undefined && alpha.id === 'id-alpha' && alpha.title === 'alpha') {
    report.pass('list publishes id+title for a registry workspace', alpha.id)
  } else {
    report.fail('list publishes id+title for a registry workspace', JSON.stringify(alpha))
  }

  // ---- mutate add ------------------------------------------------------
  const added = await call(ROUTE_MUTATE, {
    method: 'POST',
    body: JSON.stringify({ workspace: fixture.workspaceDir, action: 'add', path: fixture.affiliateDir }),
  })
  const physicalAffiliate = realpathSync.native(fixture.affiliateDir)
  if (added.status === 200 && Array.isArray(added.json?.roots) && added.json.roots.includes(physicalAffiliate)) {
    report.pass('mutate add persists the physical root', physicalAffiliate)
  } else {
    report.fail('mutate add persists the physical root', 'HTTP ' + added.status + ' ' + added.text)
  }

  // ---- mutate add is idempotent ----------------------------------------
  const addedTwice = await call(ROUTE_MUTATE, {
    method: 'POST',
    body: JSON.stringify({ workspace: fixture.workspaceDir, action: 'add', path: fixture.affiliateDir }),
  })
  if (addedTwice.status === 200 && addedTwice.json.roots.length === 1) {
    report.pass('mutate add twice does not duplicate the root')
  } else {
    report.fail('mutate add twice does not duplicate the root', addedTwice.text)
  }

  // ---- mutate rejects a missing path (no state change) -----------------
  const missing = await call(ROUTE_MUTATE, {
    method: 'POST',
    body: JSON.stringify({ workspace: fixture.workspaceDir, action: 'add', path: join(fixture.root, 'nope-' + Date.now()) }),
  })
  if (missing.status === 400 && typeof missing.json?.error === 'string') {
    report.pass('mutate refuses a nonexistent path', missing.json.error)
  } else {
    report.fail('mutate refuses a nonexistent path', 'HTTP ' + missing.status + ' ' + missing.text)
  }

  // ---- mutate rejects a relative workspace key -------------------------
  const badKey = await call(ROUTE_MUTATE, {
    method: 'POST',
    body: JSON.stringify({ workspace: 'not-absolute', action: 'add', path: fixture.affiliateDir }),
  })
  if (badKey.status === 400) report.pass('mutate refuses a relative workspace key', badKey.json?.error)
  else report.fail('mutate refuses a relative workspace key', 'HTTP ' + badKey.status + ' ' + badKey.text)

  // ---- mutate rejects a symlinked grant --------------------------------
  // validateRoot refuses symlinks so a grant cannot be redirected later.
  const symlinkPath = join(fixture.root, 'link-to-affiliate')
  try {
    symlinkSync(physicalAffiliate, symlinkPath)
  } catch {
    /* symlinks may be unavailable; the assertion below then reports on 400 */
  }
  const symlinked = await call(ROUTE_MUTATE, {
    method: 'POST',
    body: JSON.stringify({ workspace: fixture.workspaceDir, action: 'add', path: symlinkPath }),
  })
  if (symlinked.status === 400) report.pass('mutate refuses a symlinked path', symlinked.json?.error)
  else if (symlinked.status === 200) report.fail('mutate refuses a symlinked path', 'accepted ' + symlinked.text)
  else report.info('mutate refuses a symlinked path', 'HTTP ' + symlinked.status)

  // ---- mutate set / remove round-trip ----------------------------------
  const setResult = await call(ROUTE_MUTATE, {
    method: 'POST',
    body: JSON.stringify({ workspace: fixture.workspaceDir, action: 'set', paths: [fixture.affiliateDir, fixture.affiliateDir] }),
  })
  if (setResult.status === 200 && setResult.json.roots.length === 1) {
    report.pass('mutate set de-duplicates the root list')
  } else {
    report.fail('mutate set de-duplicates the root list', setResult.text)
  }
  const cleared = await call(ROUTE_MUTATE, {
    method: 'POST',
    body: JSON.stringify({ workspace: fixture.workspaceDir, action: 'set', paths: [] }),
  })
  if (cleared.status === 200 && cleared.json.roots.length === 0) report.pass('mutate set [] clears the workspace')
  else report.fail('mutate set [] clears the workspace', cleared.text)

  // ---- list reflects the store after mutations ------------------------
  const afterClear = await call(ROUTE_LIST)
  const alphaAfter = (afterClear.json?.workspaces ?? []).find((item) => item.workspace === fixture.workspaceDir)
  if (alphaAfter !== undefined && alphaAfter.roots.length === 0) {
    report.pass('list reflects the cleared store')
  } else {
    report.fail('list reflects the cleared store', JSON.stringify(alphaAfter))
  }

  // ---- the store file really exists after mutations -------------------
  let storedOk = false
  try {
    storedOk = statSync(storePath).isFile()
  } catch {
    storedOk = false
  }
  if (storedOk) report.pass('store file was written', storePath)
  else report.fail('store file was written', storePath)

  // ---- check route: writable-by-policy path ---------------------------
  // resolvePolicy is stubbed here, so this exercises the route's own verdict
  // logic (mode switch + root matching), not the live decoration.
  const writable = await call(ROUTE_CHECK + '?path=' + encodeURIComponent(fixture.affiliateDir))
  if (writable.status === 200 && writable.json?.writable === false) {
    report.pass('check reports not-writable outside the workspace root', writable.json.reason)
  } else {
    report.fail('check reports not-writable outside the workspace root', writable.text)
  }
  const inside = await call(ROUTE_CHECK + '?path=' + encodeURIComponent(fixture.workspaceDir))
  if (inside.status === 200 && inside.json?.writable === true) {
    report.pass('check reports writable under the workspace root', inside.json.reason)
  } else {
    report.fail('check reports writable under the workspace root', inside.text)
  }
  const noArg = await call(ROUTE_CHECK)
  if (noArg.status === 400) report.pass('check refuses a missing path argument', noArg.json?.error)
  else report.fail('check refuses a missing path argument', noArg.text)

  // ---- validateRoot directly (the guard every mutation goes through) ---
  try {
    validateRoot('relative/path')
    report.fail('validateRoot refuses a relative path', 'accepted')
  } catch (error) {
    report.pass('validateRoot refuses a relative path', error.message)
  }

  // ---- B. live probes --------------------------------------------------
  if (skipLive) {
    report.skip('live route probes', '--skip-live')
  } else {
    const { secret } = readAuthSecret()
    report.info('live host', dshBase(port) + ' (auth secret from credentials/env, value withheld)')
    const liveAnon = await request(ROUTE_LIST, { port })
    if (liveAnon.status === 401 || liveAnon.status === 403) {
      report.pass('live list refuses the unauthenticated request', 'HTTP ' + liveAnon.status)
    } else {
      report.fail('live list refuses the unauthenticated request', 'HTTP ' + liveAnon.status)
    }
    const liveAuthed = await request(ROUTE_LIST, { port, secret })
    if (liveAuthed.status === 200 && Array.isArray(liveAuthed.json?.workspaces)) {
      report.pass('live list answers with JSON when authenticated', liveAuthed.json.workspaces.length + ' workspace(s)')
    } else {
      report.fail('live list answers with JSON when authenticated', 'HTTP ' + liveAuthed.status)
    }

    // A malformed mutate must be refused before it can touch the store. This is
    // the ONLY live POST in the toolset and it is designed to be a no-op: no
    // workspace and no path, so the route returns 400 on validation.
    const liveBad = await request(ROUTE_MUTATE, {
      port,
      secret,
      method: 'POST',
      body: { action: 'add' },
    })
    if (liveBad.status === 400 && typeof liveBad.json?.error === 'string') {
      report.pass('live mutate refuses an empty body (no state change)', liveBad.json.error)
    } else {
      report.fail('live mutate refuses an empty body (no state change)', 'HTTP ' + liveBad.status + ' ' + liveBad.text)
    }
  }

  // ---- cleanup ---------------------------------------------------------
  try {
    rmSync(fixture.root, { recursive: true, force: true })
    report.pass('fixture cleaned up', fixture.root)
  } catch (error) {
    report.info('fixture cleaned up', 'left behind: ' + fixture.root)
  }

  const summary = report.print()
  return summary.failed === 0 ? 0 : 1
})
