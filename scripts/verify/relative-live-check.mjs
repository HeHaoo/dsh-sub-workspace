#!/usr/bin/env node
/**
 * End-to-end check of the relative-path capability against a RUNNING DSH.
 *
 * Unlike routes-check (in-process fixture), this drives the real host routes
 * over HTTP with a real auth cookie. It proves whether the DSH process actually
 * has the relative-path code live, not just that the workspace source is right.
 *
 * Sequence (all cleaned up at the end):
 *   1. list           -> discover a real workspace key the host knows
 *   2. create a temp subdirectory inside that workspace
 *   3. mutate add     -> with a RELATIVE path; expect 200 + physical root stored
 *   4. check          -> with the same RELATIVE path; expect writable=true
 *   5. mutate remove  -> with the RELATIVE path; expect the root dropped
 *   6. delete the temp subdirectory
 *
 * Usage: node scripts/verify/relative-live-check.mjs [--port N]
 * Exit codes: 0 all passed, 1 a check failed, 2 precondition missing.
 */

import { mkdirSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { dshPort, parseArgs, readAuthSecret, reporter, request, run } from './lib/env.mjs'
import { ROUTE_CHECK, ROUTE_LIST, ROUTE_MUTATE } from './lib/api.mjs'

const args = parseArgs()
const port = dshPort(args.get('port'))

await run(async () => {
  const report = reporter('relative-path live end-to-end check')
  const { secret } = readAuthSecret()

  // ---- 1. discover a real workspace key -------------------------------
  const listed = await request(ROUTE_LIST, { port, secret })
  if (listed.status !== 200 || !Array.isArray(listed.json?.workspaces) || listed.json.workspaces.length === 0) {
    report.fail('list discovers a workspace', 'HTTP ' + listed.status + ' ' + listed.text)
    return 1
  }
  const workspaces = listed.json.workspaces
  const preferred = workspaces.find((item) => /dsh-sub-workspace/i.test(item.workspace)) || workspaces[0]
  const workspace = preferred.workspace
  report.pass('list discovers a workspace', workspace)

  // ---- 2. temp subdirectory inside that workspace ---------------------
  const relName = '.sws-relative-verify-' + Date.now()
  const tempDir = join(workspace, relName)
  mkdirSync(tempDir, { recursive: true })
  const physical = realpathSync.native(tempDir)
  report.info('relative path', relName + '  ->  ' + physical)

  let added = false
  try {
    // ---- 3. mutate add with a RELATIVE path ----------------------------
    const addResult = await request(ROUTE_MUTATE, {
      port,
      secret,
      method: 'POST',
      body: { workspace, action: 'add', path: relName },
    })
    added = addResult.status === 200 && Array.isArray(addResult.json?.roots) && addResult.json.roots.includes(physical)
    if (added) report.pass('mutate add accepts a relative path', physical)
    else report.fail('mutate add accepts a relative path', 'HTTP ' + addResult.status + ' ' + addResult.text)

    // ---- 4. check with the same RELATIVE path --------------------------
    const checkResult = await request(ROUTE_CHECK + '?path=' + encodeURIComponent(relName) + '&workspace=' + encodeURIComponent(workspace), { port, secret })
    if (checkResult.status === 200 && checkResult.json?.writable === true) {
      report.pass('check resolves a relative path as writable', checkResult.json.reason)
    } else {
      report.fail('check resolves a relative path as writable', 'HTTP ' + checkResult.status + ' ' + checkResult.text)
    }

    // ---- 5. mutate remove with the RELATIVE path -----------------------
    const removeResult = await request(ROUTE_MUTATE, {
      port,
      secret,
      method: 'POST',
      body: { workspace, action: 'remove', path: relName },
    })
    const removed = removeResult.status === 200 && Array.isArray(removeResult.json?.roots) && !removeResult.json.roots.includes(physical)
    if (removed) {
      added = false
      report.pass('mutate remove drops the relative root', physical)
    } else {
      report.fail('mutate remove drops the relative root', 'HTTP ' + removeResult.status + ' ' + removeResult.text)
    }
  } finally {
    // ---- 6. cleanup: make sure the store has no leftover root ----------
    if (added) {
      try {
        await request(ROUTE_MUTATE, {
          port,
          secret,
          method: 'POST',
          body: { workspace, action: 'remove', path: relName },
        })
      } catch { /* best effort */ }
    }
    rmSync(tempDir, { recursive: true, force: true })
  }

  const summary = report.print()
  return summary.failed === 0 ? 0 : 1
})
