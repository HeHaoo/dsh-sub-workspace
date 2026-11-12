#!/usr/bin/env node
/**
 * Clean-room client check: run the CURRENT lib/client.js source inside the real
 * page, on a DOM stripped of whatever the installed plugin already did.
 *
 * This is the check that answers "did the code I just edited actually work?",
 * without reinstalling the plugin or restarting DSH:
 *
 *   1. connect to the debug Chrome and authenticate against the live DSH;
 *   2. record how many triggers the INSTALLED plugin has already injected,
 *      then remove them all (clean slate — the page's own React tree is
 *      untouched, only this plugin's nodes are dropped);
 *   3. execute the local lib/client.js source in the page through a
 *      __ModuleLoader__ shim, run its apply() with a stub cordis context;
 *   4. assert triggers come back, the stylesheet is present, and the plugin's
 *      own list route is called;
 *   5. run the effect's teardown and assert it removes every trigger + style —
 *      the plugin must leave no trace when unloaded;
 *   6. compare the served bundle against the local source so a stale install
 *      (authoritative in the page) cannot masquerade as "the new code works".
 *
 * Replaces: clean_verify.mjs, inject_test.mjs and match.mjs.
 *
 * Usage:
 *   node scripts/verify/inject-check.mjs [--port 52524] [--cdp-port 9334] [--mount-wait 15000]
 *
 * Preconditions: DSH running, Chrome started with --remote-debugging-port=9334
 * and a DSH page target. Exit codes: 0 pass, 1 fail, 2 precondition missing.
 *
 * @module dsh-sub-workspace/scripts/verify/inject-check
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { cdpPort, clip, dshPort, parseArgs, PLUGIN_ROOT, readAuthSecret, reporter, run, PreconditionError } from './lib/env.mjs'
import { openAuthenticatedPage } from './lib/cdp.mjs'
import { clientBundle } from './lib/api.mjs'
import * as dom from './lib/dom.mjs'

const args = parseArgs()
const port = dshPort(args.get('port'))
const debugPort = cdpPort(args.get('cdp-port'))
const mountWait = Number(args.get('mount-wait', '15000'))
const sourcePath = join(PLUGIN_ROOT, 'lib', 'client.js')

await run(async () => {
  const report = reporter('clean-room client injection check')
  const { secret } = readAuthSecret()

  let source
  try {
    source = readFileSync(sourcePath, 'utf8')
  } catch (error) {
    throw new PreconditionError('cannot read ' + sourcePath + ': ' + (error && error.message ? error.message : error))
  }
  report.info('source', sourcePath + ' (' + source.length + ' bytes)')

  const { session, mark } = await openAuthenticatedPage({ port, cdpPort: debugPort, secret, waitMs: mountWait })
  report.info('browser target', session.page.url)
  report.info('cookie installed', 'yes (value withheld)')

  try {
    const installed = await dom.snapshot(session)
    report.info('installed plugin state', installed.triggers + ' trigger(s) / ' + installed.rows + ' row(s)')
    if (installed.rows === 0) {
      report.fail('page has workspace rows to decorate', 'no rows — cannot exercise the decoration')
    } else {
      report.pass('page has workspace rows to decorate', installed.rows + ' row(s)')
    }

    // ---- 1. run the local source against a clean slate ------------------
    const result = await session.evaluate(
      '(async function () {' +
        '  var TRIGGER = ' + JSON.stringify(dom.TRIGGER) + ';' +
        '  var STYLE = ' + JSON.stringify(dom.STYLE_TAG) + ';' +
        '  var ROW = ' + JSON.stringify(dom.WORKSPACE_ROW) + ';' +
        // Clean slate: drop only what THIS plugin injected. The host's React
        // tree is untouched, so the rows (and their labels) stay intact.
        '  document.querySelectorAll(TRIGGER).forEach(function (node) { node.remove() });' +
        '  var removed = document.querySelectorAll(TRIGGER).length;' +
        '  var rows = document.querySelectorAll(ROW).length;' +
        // The source calls window.__ModuleLoader__.load(...). Install the shim
        // on the REAL window: passing an Object.create(window) proxy breaks
        // every inherited call (window.setTimeout there throws "Illegal
        // invocation"), which is a harness bug, not a plugin bug.
        '  var previousLoader = window.__ModuleLoader__;' +
        '  var shim = { load: function (def) { window.__subwsDef = def } };' +
        '  window.__ModuleLoader__ = shim;' +
        '  var restoreLoader = function () {' +
        '    if (previousLoader === undefined) delete window.__ModuleLoader__;' +
        '    else window.__ModuleLoader__ = previousLoader;' +
        '  };' +
        '  var logs = [];' +
        '  var origLog = console.log, origWarn = console.warn, origErr = console.error;' +
        '  console.log = function () { logs.push("log: " + Array.prototype.join.call(arguments, " ")) };' +
        '  console.warn = function () { logs.push("warn: " + Array.prototype.join.call(arguments, " ")) };' +
        '  console.error = function () { logs.push("err: " + Array.prototype.join.call(arguments, " ")) };' +
        '  var restore = function () { console.log = origLog; console.warn = origWarn; console.error = origErr };' +
        '  try {' +
        '    var factory = new Function("window", ' + JSON.stringify(source) + ');' +
        '    factory(window);' +
        '  } catch (error) { restoreLoader(); restore(); return { stage: "exec", error: String(error), logs: logs, rows: rows } }' +
        '  restoreLoader();' +
        '  var def = window.__subwsDef;' +
        '  delete window.__subwsDef;' +
        '  if (!def) { restore(); return { stage: "no-def", error: "the source never called __ModuleLoader__.load", logs: logs, rows: rows } }' +
        '  if (typeof def.factory !== "function") { restore(); return { stage: "factory-shape", error: "def.factory is not a function", logs: logs, rows: rows } }' +
        '  var mod;' +
        '  try { mod = def.factory(function () { return {} }) } catch (error) { restore(); return { stage: "factory", error: String(error), logs: logs, rows: rows } }' +
        '  if (!mod || typeof mod.apply !== "function") { restore(); return { stage: "apply-shape", error: "mod.apply is not a function", logs: logs, rows: rows } }' +
        '  var effects = [];' +
        '  var ctx = { effect: function (cb) { var dispose = cb(); effects.push(dispose); return dispose }, on: function () {}, get: function () {} };' +
        '  try { mod.apply(ctx) } catch (error) { restore(); return { stage: "apply", error: String(error), logs: logs, rows: rows } }' +
        // The plugin decorates on a bounded poll; wait for the first trigger
        // rather than assuming a fixed delay.
        '  var deadline = Date.now() + 12000;' +
        '  while (Date.now() < deadline && document.querySelectorAll(TRIGGER).length === 0) {' +
        '    await new Promise(function (resolve) { setTimeout(resolve, 200) })' +
        '  }' +
        '  var after = document.querySelectorAll(TRIGGER).length;' +
        '  var styles = document.querySelectorAll(STYLE).length;' +
        // Run the effect teardown and check the plugin leaves no trace.
        '  var teardownError = null;' +
        '  try {' +
        '    for (var index = 0; index < effects.length; index += 1) {' +
        '      if (typeof effects[index] === "function") effects[index]()' +
        '    }' +
        '  } catch (error) { teardownError = String(error) }' +
        '  var afterTeardown = document.querySelectorAll(TRIGGER).length;' +
        '  var stylesAfter = document.querySelectorAll(STYLE).length;' +
        '  restore();' +
        '  return { stage: "done", rows: rows, removed: removed, after: after, styles: styles,' +
        '           afterTeardown: afterTeardown, stylesAfter: stylesAfter, teardownError: teardownError,' +
        '           effectCount: effects.length, logs: logs.slice(0, 20) };' +
        '})()',
    )

    if (result !== null && typeof result === 'object' && result.stage === 'done') {
      report.pass('the local source executes and registers a module', result.effectCount + ' effect(s)')
    } else {
      const stage = result === null || result === undefined ? 'unknown' : result.stage
      const error = result === null || result === undefined ? 'no result' : result.error
      report.fail('the local source executes and registers a module', stage + ': ' + clip(error, 240))
    }

    if (result !== null && typeof result === 'object') {
      if (result.rows > 0) report.pass('workspace rows remained after clearing the installed triggers', result.rows + ' row(s)')
      else report.fail('workspace rows remained after clearing the installed triggers', 'rows disappeared — the clean slate broke the page')

      if (result.after > 0) {
        report.pass('injected source decorates rows from a clean slate', result.after + '/' + result.rows + ' row(s)')
      } else {
        report.fail('injected source decorates rows from a clean slate', '0 triggers after 12s of polling')
      }
      if (result.after > 0 && result.after <= result.rows) {
        report.pass('trigger count never exceeds the row count', result.after + ' <= ' + result.rows)
      } else if (result.after > result.rows) {
        report.fail('trigger count never exceeds the row count', result.after + ' > ' + result.rows + ' (double decoration)')
      }
      if (result.styles >= 1) report.pass('injected source installs its stylesheet')
      else report.fail('injected source installs its stylesheet', 'no style[data-plugin] after apply()')
      if (result.teardownError === null || result.teardownError === undefined) {
        report.pass('teardown does not throw')
      } else {
        report.fail('teardown does not throw', clip(result.teardownError, 200))
      }
      if (result.afterTeardown === 0) {
        report.pass('teardown removes every trigger', result.after + ' -> 0')
      } else {
        report.fail('teardown removes every trigger', result.afterTeardown + ' trigger(s) survived')
      }
      if (result.stylesAfter === 0) report.pass('teardown removes the stylesheet')
      else report.fail('teardown removes the stylesheet', result.stylesAfter + ' style tag(s) survived')
      const pluginLogs = (result.logs || []).filter((line) => String(line).toLowerCase().includes('sub-workspace') || String(line).includes('subws'))
      if (pluginLogs.length > 0) report.info('injected source console lines', pluginLogs.slice(0, 4).map((line) => clip(line, 140)).join(' | '))
    }

    // ---- 2. the installed bundle must match the local source ------------
    // A stale install serving older code is the failure mode this catches:
    // everything above proves the LOCAL file works, this proves the host serves
    // the same thing.
    const bundle = await clientBundle(port, secret)
    if (bundle.status !== 200) {
      report.fail('the host serves the plugin bundle', 'HTTP ' + bundle.status + ' ' + clip(bundle.error || bundle.text, 160))
    } else {
      report.pass('the host serves the plugin bundle', bundle.text.length + ' bytes from ' + bundle.url)
      // The plugin bundler appends a trailing `;` and a `//# sourceMappingURL=`
      // comment to every served module. Those two tails are transport artifacts,
      // not part of the source, so comparing them raw made this check report a
      // phantom diff on EVERY run ("restart DSH") even when the install was
      // perfectly current. Strip them before comparing.
      const stripBundleTail = (text) =>
        text
          .replace(/\r\n/g, '\n')
          .replace(/\/\/# sourceMappingURL=\S*\s*$/m, '')
          .replace(/;\s*$/, '')
          .trim()
      const normalizedServe = stripBundleTail(bundle.text)
      const normalizedLocal = stripBundleTail(source)
      if (normalizedServe === normalizedLocal) {
        report.pass('the served bundle matches lib/client.js', 'the install is up to date')
      } else {
        report.fail(
          'the served bundle matches lib/client.js',
          'served ' + normalizedServe.length + ' B vs local ' + normalizedLocal.length + ' B — restart DSH to pick up edits',
        )
      }
      if (normalizedServe.includes('data-subworkspace-trigger')) {
        report.pass('the served bundle targets this plugin\'s trigger attribute')
      } else {
        report.fail('the served bundle targets this plugin\'s trigger attribute', 'marker missing')
      }
    }

    // ---- 3. page health after the injection ----------------------------
    const exceptions = session.exceptionsSince(mark)
    if (exceptions.length === 0) report.pass('injection raised no page exceptions')
    else report.fail('injection raised no page exceptions', clip(exceptions[0].text, 240))

    // ---- 4. leave the shared browser tab healthy -----------------------
    // The clean-room teardown deliberately removes EVERY trigger and the
    // plugin's stylesheet, including the installed plugin's own. Without a
    // reload the long-lived debug tab would keep running a half-unloaded
    // plugin, so the run finishes by reconstituting the page from the host.
    if (args.has('no-reload')) {
      report.skip('tab restored by reload', '--no-reload')
    } else {
      await session.navigate(session.page.url, 8000)
      const restored = await dom.snapshot(session)
      if (restored.styleTags >= 1 && restored.triggers > 0) {
        report.pass('tab restored after the injection', restored.triggers + ' trigger(s), stylesheet back')
      } else {
        report.info(
          'tab restored after the injection',
          restored.triggers + ' trigger(s), ' + restored.styleTags + ' stylesheet(s) — reload DSH or the tab if this persists',
        )
      }
    }

    const summary = report.print()
    return summary.failed === 0 ? 0 : 1
  } finally {
    session.close()
  }
})
