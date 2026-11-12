#!/usr/bin/env node
/**
 * Read-only host-route check.
 *
 * The cheapest, always-safe verification: prove that a running DSH exposes the
 * plugin's authenticated API with the expected shape, without touching the
 * browser or mutating any affiliate list.
 *
 * Replaces: check.mjs, check2.mjs, verify.mjs, state.mjs, probe.mjs, probe2.mjs,
 * probe3.mjs, getbundle.mjs, and the host half of fullcheck.mjs.
 *
 * Usage:
 *   node scripts/verify/api-check.mjs [--port 52524] [--json] [--quiet]
 *
 * Precondition: DSH web is listening on the port; credentials are readable.
 * Exit codes: 0 all checks passed, 1 a check failed, 2 precondition missing.
 *
 * @module dsh-sub-workspace/scripts/verify/api-check
 */

import {
  clip,
  credentialsFile,
  dshBase,
  dshPort,
  parseArgs,
  PLUGIN_ROOT,
  readAuthSecret,
  reporter,
  request,
  run,
} from './lib/env.mjs'
import { checkPath, clientBundle, indexHtml, listSummary, ROUTE_CHECK, ROUTE_LIST } from './lib/api.mjs'

/** The credentials file path, for the 401 hint. */
function credentialsFileForHint() {
  return credentialsFile()
}

const args = parseArgs()
const port = dshPort(args.get('port'))

await run(async () => {
  const report = reporter('host API check — ' + dshBase(port))
  const { secret, source } = readAuthSecret()
  report.info('auth', 'secret from ' + source + ' (value withheld)')
  report.info('plugin root', PLUGIN_ROOT)

  // ---- 1. the list route answers 200 with real JSON -----------------------
  const list = await listSummary(port, secret)
  report.info('GET ' + ROUTE_LIST, 'HTTP ' + list.status + ', ' + clip(list.raw, 120))
  if (list.status !== 200) {
    report.fail('list route returns 200', 'got HTTP ' + list.status)
    if (list.status === 401 || list.status === 403) {
      // The single most common cause: the browser-session secret rotated (DSH
      // reissued it) while the file on disk — or the exported env var — is
      // stale. Say so instead of leaving the user staring at a bare 401.
      report.info(
        'auth hint',
        'the signing secret was rejected — if DSH restarted, refresh it: unset DSH_AUTH_SECRET, or re-read ' +
          credentialsFileForHint(),
      )
    }
  } else {
    report.pass('list route returns 200')
  }
  if (list.ok) {
    report.pass('list payload is JSON with workspaces[]', list.workspaces.length + ' workspace(s)')
  } else {
    report.fail('list payload is JSON with workspaces[]', clip(list.raw, 200))
  }
  if (typeof list.storePath === 'string' && list.storePath !== '') {
    report.pass('list reports storePath', list.storePath)
  } else {
    report.fail('list reports storePath', 'missing')
  }
  if (list.registry === 'ok' || list.registry === 'unavailable') {
    report.pass('list reports registry status', list.registry)
  } else {
    report.fail('list reports registry status', JSON.stringify(list.registry))
  }

  // A workspace carrying an id/title proves the registry mapping is live; an
  // installed plugin without a registry is not an error per se, so it is INFO.
  const identified = list.workspaces.filter((item) => item !== null && typeof item === 'object' && item.id !== undefined)
  if (identified.length > 0) {
    report.pass('workspaces carry registry ids', identified.length + '/' + list.workspaces.length)
    report.info('sample', clip(JSON.stringify(identified[0]), 200))
  } else {
    report.info('workspaces carry registry ids', '0/' + list.workspaces.length + ' (registry ' + list.registry + ')')
  }

  // ---- 2. the route is authenticated ------------------------------------
  const anon = await request(ROUTE_LIST, { port })
  if (anon.status === 401 || anon.status === 403) {
    report.pass('unauthenticated list is refused', 'HTTP ' + anon.status)
  } else if (anon.status === 200) {
    report.fail('unauthenticated list is refused', 'HTTP 200 — the route is world-readable')
  } else {
    report.info('unauthenticated list is refused', 'HTTP ' + anon.status)
  }

  // ---- 3. an unknown /api route is not swallowed by ours ----------------
  const unknown = await request('/api/__verify_no_such_route__', { port, secret })
  report.info('unknown /api route', 'HTTP ' + unknown.status)
  if (unknown.status !== 200) report.pass('unknown /api route is not 200', 'HTTP ' + unknown.status)
  else report.fail('unknown /api route is not 200', 'HTTP 200')

  // ---- 4. the read-only check route answers -----------------------------
  // It reports whether a path would be writable now; it never grants.
  const probePath = PLUGIN_ROOT
  const checked = await checkPath(port, secret, probePath)
  if (checked.status === 200 && checked.json !== undefined) {
    report.pass('GET ' + ROUTE_CHECK, 'writable=' + String(checked.json.writable) + ', reason=' + clip(checked.json.reason, 80))
    report.info('matchedRoot', clip(JSON.stringify(checked.json.matchedRoot), 120))
  } else {
    report.fail('GET ' + ROUTE_CHECK, 'HTTP ' + checked.status + ' ' + clip(checked.text, 160))
  }
  const badCheck = await checkPath(port, secret, '/definitely/not/a/real/dir/' + Date.now())
  if (badCheck.status === 200 && badCheck.json !== undefined && badCheck.json.writable === false) {
    report.pass('check refuses a nonexistent path', clip(badCheck.json.reason, 100))
  } else {
    report.fail('check refuses a nonexistent path', 'HTTP ' + badCheck.status + ' ' + clip(badCheck.text, 160))
  }

  // ---- 5. the host serves the plugin's browser bundle -------------------
  const bundle = await clientBundle(port, secret)
  if (bundle.status === 200 && bundle.text.includes('data-subworkspace-trigger')) {
    report.pass('served client bundle contains this plugin', bundle.text.length + ' bytes')
    if (bundle.text.includes('__ModuleLoader__')) report.pass('bundle registers with __ModuleLoader__')
    else report.fail('bundle registers with __ModuleLoader__', 'marker missing')
  } else {
    report.fail('served client bundle contains this plugin', 'HTTP ' + bundle.status + ' ' + clip(bundle.text, 160))
  }

  // ---- 6. the app shell is served --------------------------------------
  const shell = await indexHtml(port, secret)
  if (shell.status === 200 && shell.text.length > 0) {
    report.pass('app shell is served', shell.text.length + ' bytes')
  } else {
    report.fail('app shell is served', 'HTTP ' + shell.status)
  }

  const summary = report.print()
  if (args.has('json')) {
    console.log(
      JSON.stringify({
        port,
        base: dshBase(port),
        summary,
        workspaces: list.workspaces,
        storePath: list.storePath,
        registry: list.registry,
      }),
    )
  }
  return summary.failed === 0 ? 0 : 1
})
