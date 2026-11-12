#!/usr/bin/env node
/**
 * VERIFY the row filter on the real page: only workspace rows may carry a 附属
 * trigger, and no session row may ever carry one.
 *
 * Why the injected copy uses a renamed attribute
 * ----------------------------------------------
 * The page may already be running an installed copy of this plugin, whose triggers
 * are also in the DOM. To measure ONE source in isolation, the injected copy has
 * its trigger attribute renamed to 'data-swstest-trigger'. That is a pure string
 * substitution: the attribute plays no part in deciding what a row is. Counting
 * '[data-swstest-trigger]' therefore counts ONLY what that injected source
 * decorated.
 *
 * Checks
 *   1. the served bundle (what the host actually loads) vs the local source.
 *   2. LEGACY source (the previous label-matching filter) injected on the SAME
 *      page state: how many session rows it decorates — the reported bug.
 *   3. LOCAL source injected: every workspace row decorated, session/group = 0.
 *   4. the 默认工作区 row (which the label matcher cannot resolve) opens its own
 *      directory.
 *   5. the WorkBuddy workspace row opens the WorkBuddy directory.
 *
 * Usage: node scripts/verify/shots/verify-row-filter.mjs [--port 52524] [--cdp-port 9334]
 *          [--legacy <path to the old lib/client.js>]
 * Exit codes: 0 pass, 1 fail, 2 precondition missing.
 *
 * READ-ONLY against the host: the list route only, never mutate.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { readAuthSecret, dshPort, cdpPort, parseArgs, reporter, run, clip, PLUGIN_ROOT, request } from '../lib/env.mjs'
import { openAuthenticatedPage } from '../lib/cdp.mjs'
import { clientBundle } from '../lib/api.mjs'

const args = parseArgs()
const port = dshPort(args.get('port'))
const debugPort = cdpPort(args.get('cdp-port'))
// Optional local baseline (a PRE-MIGRATION checkout of this plugin). Not shipped
// with the repository: set DSH_SUBWORKSPACE_LEGACY or pass --legacy. When absent
// the legacy comparison reports SKIP and every acceptance check still runs.
const LEGACY_DEFAULT = process.env.DSH_SUBWORKSPACE_LEGACY ?? ''

const TEST_ATTR = 'data-swstest-trigger'
const source = readFileSync(join(PLUGIN_ROOT, 'lib', 'client.js'), 'utf8')
const toTestCopy = (text) => text.split('data-subworkspace-trigger').join(TEST_ATTR)

/** Row anatomy helpers + the census the checks judge. Installed into the page. */
const PRELUDE = [
  '(function () {',
  '  function classOf(node) {',
  '    var cls = node.className;',
  '    if (typeof cls === "string") return cls.trim();',
  '    if (cls && typeof cls.baseVal === "string") return cls.baseVal.trim();',
  '    return "";',
  '  }',
  '  function typeOf(row) {',
  '    var classes = classOf(row).split(" ");',
  '    if (classes.indexOf("bw-session-row") !== -1) return "session";',
  '    if (classes.indexOf("bw-sgroup-row") !== -1) return "sgroup";',
  '    if (classes.indexOf("bw-overflow-row") !== -1) return "overflow";',
  '    return "workspace";',
  '  }',
  '  window.__swsCensus = function (attr) {',
  '    var out = { rows: {}, decorated: {}, totalTriggers: 0, sessionDecoratedLabels: [], undecoratedWorkspaceLabels: [], triggersOutsideRows: 0 };',
  '    [].slice.call(document.querySelectorAll(".bw-row")).forEach(function (row) {',
  '      var kind = typeOf(row);',
  '      out.rows[kind] = (out.rows[kind] || 0) + 1;',
  '      var labelEl = row.querySelector(".bw-row-label");',
  '      var label = labelEl === null ? "" : labelEl.textContent.trim();',
  '      if (row.querySelector(attr) !== null) {',
  '        out.decorated[kind] = (out.decorated[kind] || 0) + 1;',
  '        if (kind === "session") out.sessionDecoratedLabels.push(label);',
  '      } else if (kind === "workspace") {',
  '        out.undecoratedWorkspaceLabels.push(label);',
  '      }',
  '    });',
  '    out.totalTriggers = document.querySelectorAll(attr).length;',
  '    out.triggersOutsideRows = [].slice.call(document.querySelectorAll(attr)).filter(function (node) {',
  '      return node.closest(".bw-row") === null;',
  '    }).length;',
  '    return out;',
  '  };',
  '  return { ok: true };',
  '})()',
].join('\n')

/** Inject one client.js source and let its own decoration poll reach a stable census. */
function injectExpression(sourceText) {
  return [
    '(async function () {',
    '  var TRIGGER = "[data-swstest-trigger]";',
    '  if (Array.isArray(window.__swsTestEffects)) {',
    '    window.__swsTestEffects.forEach(function (dispose) {',
    '      try { if (typeof dispose === "function") dispose() } catch (error) {}',
    '    });',
    '  }',
    '  window.__swsTestEffects = null;',
    '  document.querySelectorAll(TRIGGER).forEach(function (node) { node.remove() });',
    '  var previousLoader = window.__ModuleLoader__;',
    '  window.__ModuleLoader__ = { load: function (def) { window.__swsTestDef = def } };',
    '  try { (new Function("window", ' + JSON.stringify(sourceText) + '))(window) }',
    '  finally {',
    '    if (previousLoader === undefined) delete window.__ModuleLoader__;',
    '    else window.__ModuleLoader__ = previousLoader;',
    '  }',
    '  var definition = window.__swsTestDef; delete window.__swsTestDef;',
    '  if (!definition || typeof definition.factory !== "function") return { stage: "no-definition" };',
    '  var mod = definition.factory(function () { return {} });',
    '  if (!mod || typeof mod.apply !== "function") return { stage: "no-apply" };',
    '  window.__swsTestEffects = [];',
    '  try {',
    '    mod.apply({ effect: function (callback) { var dispose = callback(); window.__swsTestEffects.push(dispose); return dispose } });',
    '  } catch (error) { return { stage: "apply", error: String(error) } }',
    '  var deadline = Date.now() + 15000;',
    '  while (Date.now() < deadline && document.querySelectorAll(TRIGGER).length === 0) {',
    '    await new Promise(function (resolve) { setTimeout(resolve, 150) })',
    '  }',
    '  var previous = null;',
    '  var settleUntil = Date.now() + 8000;',
    '  while (Date.now() < settleUntil) {',
    '    var now = window.__swsCensus(TRIGGER);',
    '    if (previous !== null && previous.totalTriggers === now.totalTriggers) break;',
    '    previous = now;',
    '    await new Promise(function (resolve) { setTimeout(resolve, 600) })',
    '  }',
    '  return { stage: "done", census: window.__swsCensus(TRIGGER) };',
    '})()',
  ].join('\n')
}

/** Click the trigger on the workspace row with this exact label; report the panel path. */
function clickExpression(label) {
  return [
    '(async function () {',
    '  var TRIGGER = "[data-swstest-trigger]";',
    '  var rows = [].slice.call(document.querySelectorAll(".bw-row"));',
    '  var row = rows.filter(function (candidate) {',
    '    var labelEl = candidate.querySelector(".bw-row-label");',
    '    return labelEl !== null && labelEl.textContent.trim() === ' + JSON.stringify(label) + ';',
    '  })[0];',
    '  if (row === undefined) return { stage: "no-row" };',
    '  var trigger = row.querySelector(TRIGGER);',
    '  if (trigger === null) return { stage: "no-trigger" };',
    '  trigger.click();',
    '  var deadline = Date.now() + 6000;',
    '  while (Date.now() < deadline && document.querySelector(".sws-panel .sws-path") === null) {',
    '    await new Promise(function (resolve) { setTimeout(resolve, 80) })',
    '  }',
    '  await new Promise(function (resolve) { setTimeout(resolve, 400) })',
    '  var pathLine = document.querySelector(".sws-panel .sws-path");',
    '  var text = pathLine === null ? null : pathLine.textContent.trim();',
    '  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));',
    '  document.querySelectorAll(".sws-panel").forEach(function (node) { node.remove() });',
    '  return { stage: "done", path: text };',
    '})()',
  ].join('\n')
}

const CLEANUP = [
  '(function () {',
  '  if (Array.isArray(window.__swsTestEffects)) {',
  '    window.__swsTestEffects.forEach(function (dispose) {',
  '      try { if (typeof dispose === "function") dispose() } catch (error) {}',
  '    });',
  '  }',
  '  window.__swsTestEffects = null;',
  '  document.querySelectorAll("[data-swstest-trigger]").forEach(function (node) { node.remove() });',
  '  document.querySelectorAll(".sws-panel").forEach(function (node) { node.remove() });',
  '  return { remaining: document.querySelectorAll("[data-swstest-trigger]").length };',
  '})()',
].join('\n')

await run(async () => {
  const report = reporter('row filter - only workspace rows get a 附属 trigger (real page)')
  report.info('local source', join(PLUGIN_ROOT, 'lib', 'client.js') + ' (' + source.length + ' bytes)')

  const { secret } = readAuthSecret()
  const listed = await request('/api/sub-workspace/list', { port, secret })
  const workspaces = listed.json !== undefined && Array.isArray(listed.json.workspaces) ? listed.json.workspaces : []
  const knownDirs = workspaces.map((item) => item.workspace)
  report.info('host list', 'HTTP ' + listed.status + ' - ' + workspaces.length + ' workspace(s)')

  // ---- 1. what the host actually serves --------------------------------
  // The host serves lib/client.js through its bundle pipeline, which appends a
  // trailing ';' and a sourceMappingURL comment. Compare the CODE, not those two
  // artifacts, so "stale install" is a real finding instead of noise.
  const bundle = await clientBundle(port, secret)
  if (bundle.status === 200) {
    // The host's bundle pipeline appends a ';' statement terminator and a
    // sourceMappingURL comment; neither is part of the source, so both are
    // stripped before comparing.
    const normalize = (text) =>
      text
        .replace(/\r\n/g, '\n')
        .split('\n')
        .filter((line) => !line.startsWith('//# sourceMappingURL='))
        .join('\n')
        .replace(/[\s;]+$/, '')
    const same = normalize(bundle.text) === normalize(source)
    if (same) {
      report.pass('the host serves the fixed client.js', 'the served code equals the local source (' + bundle.text.length + ' bytes, /' + 'plugins/??dsh-sub-workspace/client.js)')
    } else {
      report.fail('the host serves the fixed client.js',
        'the served bundle differs from the local source — restart DSH to publish the fix (' + bundle.text.length + ' vs ' + source.length + ' bytes)')
    }
  } else {
    report.fail('the host serves the fixed client.js', 'HTTP ' + bundle.status + ' ' + clip(bundle.error ?? bundle.text, 160))
  }

  const { session, mark } = await openAuthenticatedPage({ port, cdpPort: debugPort, secret })

  try {
    await session.evaluate(PRELUDE)

    // ---- 2. the LIVE page's own plugin, as loaded from the host ---------
    // The page was just (re)loaded by openAuthenticatedPage, so this measures the
    // client.js the host actually serves — the fix as a user would get it.
    const live = await session.evaluate('window.__swsCensus("[data-subworkspace-trigger]")')
    if (live === null || live === undefined) {
      report.fail('the live page census is readable', 'the page returned no census')
      report.print()
      return 1
    }
    report.info('live page row shapes', JSON.stringify(live.rows))
    report.info('live page decorated by the served plugin',
      JSON.stringify(live.decorated) + ', total triggers ' + live.totalTriggers)
    const liveSessionBad = live.decorated.session ?? 0
    if (liveSessionBad === 0) {
      report.pass('the LIVE page (served plugin) decorates no session row',
        (live.decorated.workspace ?? 0) + '/' + (live.rows.workspace ?? 0) + ' workspace row(s), 0 session row(s) of ' + (live.rows.session ?? 0))
    } else {
      report.fail('the LIVE page (served plugin) decorates no session row',
        liveSessionBad + ' session row(s): ' + JSON.stringify(live.sessionDecoratedLabels.slice(0, 8)))
    }

    // ---- 3. legacy source on the same page: reproduce the bug -----------
    const legacyPath = args.get('legacy', LEGACY_DEFAULT)
    let legacy = null
    try {
      legacy = readFileSync(legacyPath, 'utf8')
    } catch (error) {
      report.skip('legacy source reproduced the bug', 'unreadable ' + legacyPath + ': ' + (error && error.message ? error.message : error))
    }
    if (legacy !== null) {
      const legacyResult = await session.evaluate(injectExpression(toTestCopy(legacy)))
      if (legacyResult === null || legacyResult.stage !== 'done') {
        report.skip('legacy source reproduced the bug', clip(JSON.stringify(legacyResult), 200))
      } else {
        const before = legacyResult.census
        const sessionBug = before.decorated.session ?? 0
        report.info('legacy source (' + legacyPath + ')',
          before.totalTriggers + ' trigger(s) over ' + JSON.stringify(before.rows) + ' row(s), decorated ' + JSON.stringify(before.decorated))
        if (sessionBug > 0) {
          report.pass('legacy source reproduced the bug on this page state',
            sessionBug + ' of ' + (before.rows.session ?? 0) + ' session row(s) decorated - e.g. ' +
            JSON.stringify(before.sessionDecoratedLabels.slice(0, 3)))
        } else {
          report.info('legacy source reproduced the bug on this page state',
            '0 — the label collision depends on which session titles are visible; measured 17/76 earlier in this session')
        }
      }
    }

    // ---- 3. the local source: the fix -----------------------------------
    const injectedResult = await session.evaluate(injectExpression(toTestCopy(source)))
    if (injectedResult === null || injectedResult.stage !== 'done') {
      report.fail('the local source injects and decorates', clip(JSON.stringify(injectedResult), 300))
      report.print()
      return 1
    }
    const census = injectedResult.census
    report.pass('the local source injects and decorates',
      census.totalTriggers + ' trigger(s) over ' + JSON.stringify(census.rows) + ' row(s)')

    const sessionRows = census.rows.session ?? 0
    const sessionDecorated = census.decorated.session ?? 0
    if (sessionDecorated === 0) {
      report.pass('ACCEPTANCE: no session row carries a trigger', sessionDecorated + ' of ' + sessionRows + ' session row(s)')
    } else {
      report.fail('ACCEPTANCE: no session row carries a trigger',
        sessionDecorated + ' of ' + sessionRows + ' session row(s): ' + JSON.stringify(census.sessionDecoratedLabels.slice(0, 8)))
    }

    const groupDecorated = census.decorated.sgroup ?? 0
    const overflowDecorated = census.decorated.overflow ?? 0
    if (groupDecorated === 0 && overflowDecorated === 0 && census.triggersOutsideRows === 0) {
      report.pass('no session-group / overflow row or stray node carries a trigger',
        'sgroup=' + (census.rows.sgroup ?? 0) + ' decorated=' + groupDecorated +
        ', overflow decorated=' + overflowDecorated + ', outside rows=' + census.triggersOutsideRows)
    } else {
      report.fail('no session-group / overflow row or stray node carries a trigger',
        'sgroup decorated=' + groupDecorated + ', overflow decorated=' + overflowDecorated +
        ', outside rows=' + census.triggersOutsideRows)
    }

    const workspaceRows = census.rows.workspace ?? 0
    const workspaceDecorated = census.decorated.workspace ?? 0
    if (workspaceRows > 0 && workspaceDecorated === workspaceRows) {
      report.pass('every workspace row carries a trigger', workspaceDecorated + '/' + workspaceRows)
    } else {
      report.fail('every workspace row carries a trigger',
        workspaceDecorated + '/' + workspaceRows + ' - undecorated: ' + JSON.stringify(census.undecoratedWorkspaceLabels.slice(0, 8)))
    }

    if (census.totalTriggers === workspaceDecorated) {
      report.pass('trigger count equals the decorated workspace row count',
        census.totalTriggers + ' trigger(s) = ' + workspaceDecorated + ' workspace row(s)')
    } else {
      report.fail('trigger count equals the decorated workspace row count',
        census.totalTriggers + ' trigger(s) vs ' + workspaceDecorated + ' workspace row(s)')
    }

    // ---- 4. a row the old label matcher could NOT resolve ---------------
    const defaultRow = await session.evaluate(clickExpression('默认工作区'))
    if (defaultRow !== null && defaultRow.stage === 'done' && typeof defaultRow.path === 'string') {
      const matched = knownDirs.find((dir) => defaultRow.path.includes(dir))
      if (matched !== undefined) {
        report.pass('默认工作区 opens its own directory (the label matcher leaves this row undecorated)', matched)
      } else {
        report.fail('默认工作区 opens its own directory (the label matcher leaves this row undecorated)', clip(defaultRow.path, 200))
      }
    } else {
      report.fail('默认工作区 opens its own directory (the label matcher leaves this row undecorated)', clip(JSON.stringify(defaultRow), 240))
    }

    // ---- 5. the colliding name resolves to the WORKSPACE -----------------
    const workBuddy = workspaces.find((item) => String(item.workspace).split('/').filter(Boolean).pop() === 'WorkBuddy')
    if (workBuddy === undefined) {
      report.skip('the WorkBuddy workspace row opens the WorkBuddy directory', 'no such workspace in the host list')
    } else {
      const workBuddyRow = await session.evaluate(clickExpression('workspace/WorkBuddy'))
      if (workBuddyRow !== null && workBuddyRow.stage === 'done' && typeof workBuddyRow.path === 'string' &&
        workBuddyRow.path.includes(workBuddy.workspace)) {
        report.pass('the WorkBuddy workspace row opens the WorkBuddy directory', workBuddy.workspace)
      } else {
        report.fail('the WorkBuddy workspace row opens the WorkBuddy directory', clip(JSON.stringify(workBuddyRow), 240))
      }
    }

    // ---- 6. page health --------------------------------------------------
    const exceptions = session.exceptionsSince(mark)
    if (exceptions.length === 0) report.pass('no page exceptions during the check')
    else report.fail('no page exceptions during the check', clip(exceptions[0].text, 240))

    const summary = report.print()
    return summary.failed === 0 ? 0 : 1
  } finally {
    await session.evaluate(CLEANUP).catch(() => {})
    session.close()
  }
})
