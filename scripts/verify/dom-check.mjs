#!/usr/bin/env node
/**
 * Real-page DOM check: is the installed plugin decorating the live sidebar?
 *
 * Connects to the debug Chrome over CDP, authenticates with a freshly derived
 * browser-session cookie, loads the DSH web UI, and reports what the sidebar
 * actually contains: workspace row count, 「附属」 trigger count and coverage,
 * the injected stylesheet, the panel, and any page exceptions.
 *
 * The rebuild-race question ("triggers appear, then React drops them") is
 * answered by --watch / --samples, which re-samples the counts over time
 * instead of sleeping once and guessing.
 *
 * Replaces: cdp.mjs, cdp2.mjs, cdp3.mjs, dom.mjs, diag.mjs, trace.mjs, race.mjs,
 * why.mjs, probe_inside.mjs, e2e.mjs (read half), addui.mjs (read half) and the
 * DOM half of fullcheck.mjs.
 *
 * Usage:
 *   node scripts/verify/dom-check.mjs [--port 52524] [--cdp-port 9334]
 *                                     [--samples 6] [--interval 1500]
 *                                     [--mount-wait 15000] [--keep]
 *
 * Preconditions: DSH is running; Chrome was started with
 *   --remote-debugging-port=9334 --user-data-dir=<temp dir>
 * and has a page target. Exit codes: 0 pass, 1 fail, 2 precondition missing.
 *
 * @module dsh-sub-workspace/scripts/verify/dom-check
 */

import { cdpPort, clip, dshPort, parseArgs, readAuthSecret, reporter, run } from './lib/env.mjs'
import { openAuthenticatedPage } from './lib/cdp.mjs'
import * as dom from './lib/dom.mjs'

const args = parseArgs()
const port = dshPort(args.get('port'))
const debugPort = cdpPort(args.get('cdp-port'))
const samples = Number(args.get('samples', '6'))
const interval = Number(args.get('interval', '1500'))
const mountWait = Number(args.get('mount-wait', '15000'))

await run(async () => {
  const report = reporter('real-page DOM check — DSH :' + port + ', CDP :' + debugPort)
  const { secret } = readAuthSecret()
  report.info('auth', 'secret resolved (value withheld)')

  const { session, authLabel, mark } = await openAuthenticatedPage({
    port,
    cdpPort: debugPort,
    secret,
    waitMs: mountWait,
  })
  report.info('browser target', session.page.url + ' — ' + clip(session.page.title, 60))
  report.info('cookie installed', authLabel)

  try {
    const first = await dom.snapshot(session)
    report.info('page', await session.evaluate('location.href + " | " + document.title'))

    if (first.rows > 0) report.pass('sidebar shows workspace rows', first.rows + ' row(s)')
    else report.fail('sidebar shows workspace rows', 'no .bw-row[role="treeitem"] found — is dsh-better-workspace loaded?')

    if (first.officialRows > 0) report.info('official-sidebar rows', first.officialRows + ' [data-row-key^="workspace:"]')

    report.info('workspace labels', first.labels.slice(0, 8).join(', ') + (first.labels.length > 8 ? ', …' : ''))

    if (first.styleTags >= 1) report.pass('plugin stylesheet is injected', first.styleTags + ' style[data-plugin]')
    else report.fail('plugin stylesheet is injected', 'no style[data-plugin="dsh-sub-workspace"] — apply() did not run')

    // ---- coverage: which rows carry a trigger ---------------------------
    const coverage = await dom.triggerCoverage(session)
    if (coverage.withTrigger.length > 0) {
      report.pass('at least one row carries the 「附属」 trigger', coverage.withTrigger.length + ' row(s)')
    } else {
      report.fail('at least one row carries the 「附属」 trigger', '0 triggers for ' + coverage.withoutTrigger.length + ' row(s)')
    }
    if (coverage.withoutTrigger.length === 0) {
      report.pass('every workspace row carries a trigger', coverage.withTrigger.length + '/' + (coverage.withTrigger.length + coverage.withoutTrigger.length))
    } else {
      // Not necessarily a bug: a row whose label cannot be resolved to a
      // workspace directory is deliberately left undecorated.
      report.info(
        'rows without a trigger',
        coverage.withoutTrigger.length + ': ' + coverage.withoutTrigger.slice(0, 6).join(', '),
      )
    }
    if (coverage.withTrigger.length > 0) {
      report.info('trigger html', clip(await dom.firstTriggerHtml(session), 200))
    }

    // ---- the trigger is idempotent and survives a rebuild ---------------
    const again = await dom.snapshot(session)
    if (again.triggers === first.triggers) {
      report.pass('trigger count is stable between reads', String(again.triggers))
    } else {
      report.info('trigger count changed between reads', first.triggers + ' -> ' + again.triggers)
    }
    if (again.rows > 0 && again.triggers > again.rows / 2) {
      report.pass('trigger coverage looks sane', again.triggers + ' triggers / ' + again.rows + ' rows')
    } else if (again.rows === 0) {
      report.fail('trigger coverage looks sane', 'no rows to decorate')
    } else {
      report.info('trigger coverage looks sane', again.triggers + ' triggers / ' + again.rows + ' rows')
    }

    // ---- the plugin's own API traffic ----------------------------------
    const apiCalls = session.networkSince(mark).filter((url) => String(url).includes('/api/sub-workspace/'))
    if (apiCalls.length > 0) {
      report.pass('the page called the plugin API', apiCalls.length + ' request(s)')
      report.info('api urls', apiCalls.slice(0, 4).map((url) => clip(url, 100)).join(' | '))
    } else {
      report.info('the page called the plugin API', '0 sub-workspace requests observed')
    }

    // ---- optional: open a panel through a real click --------------------
    if (args.has('open-panel')) {
      const opened = await session.evaluate(
        '(function () {' +
          '  var node = document.querySelector(' + JSON.stringify(dom.TRIGGER) + ');' +
          '  if (node === null) return "no-trigger";' +
          '  node.click();' +
          '  return "clicked";' +
          '})()',
      )
      report.info('click trigger', String(opened))
      await new Promise((resolve) => setTimeout(resolve, 2500))
      const panels = await dom.count(session, dom.PANEL)
      if (panels > 0) {
        report.pass('clicking a trigger opens the affiliate panel')
        report.info('panel roots', (await dom.panelRoots(session)).slice(0, 6).join(', ') || '(none listed)')
      } else {
        report.fail('clicking a trigger opens the affiliate panel', 'no .sws-panel in the DOM')
      }
    }

    // ---- rebuild race: sample the counts over time ----------------------
    if (samples > 1) {
      const series = []
      for (let index = 0; index < samples; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, interval))
        const snap = await dom.snapshot(session)
        series.push(snap)
        console.log('    t=' + (index + 1) * interval + 'ms rows=' + snap.rows + ' triggers=' + snap.triggers)
      }
      const triggerCounts = series.map((snap) => snap.triggers)
      const monotonic = triggerCounts.every((value, index) => index === 0 || value >= triggerCounts[index - 1])
      if (monotonic && triggerCounts[triggerCounts.length - 1] > 0) {
        report.pass('triggers stay present over ' + samples + ' samples', triggerCounts.join(' -> '))
      } else if (triggerCounts[triggerCounts.length - 1] === 0) {
        report.fail('triggers stay present over ' + samples + ' samples', 'final count 0 — React dropped them')
      } else {
        report.info('triggers fluctuate over ' + samples + ' samples', triggerCounts.join(' -> '))
      }
      const rowCounts = series.map((snap) => snap.rows)
      if (rowCounts.every((value) => value === rowCounts[0])) report.pass('row count is stable', String(rowCounts[0]))
      else report.info('row count changed', rowCounts.join(' -> '))
    } else {
      report.skip('rebuild-race sampling', '--samples ' + samples)
    }

    // ---- page health ---------------------------------------------------
    // Only events the CURRENT load produced count: the debug Chrome tab is
    // long-lived and may still carry exceptions from earlier experiments, so
    // judging unmarked buffers would report someone else's crash as this run's.
    const freshExceptions = session.exceptionsSince(mark)
    if (freshExceptions.length === 0) {
      report.pass('no uncaught page exceptions during this load')
    } else {
      report.fail(
        'no uncaught page exceptions during this load',
        freshExceptions.length + ': ' + clip(freshExceptions[0].text, 240) + ' (at +' + freshExceptions[0].at + 'ms)',
      )
    }
    const staleCount = session.exceptions.length - freshExceptions.length
    if (staleCount > 0) {
      report.info('exceptions left by an earlier page load', staleCount + ' (not counted above)')
    }
    const freshConsole = session.consoleSince(mark)
    const errors = freshConsole.filter(
      (line) => line.includes('error:') || line.includes('warning:') || line.includes('assert'),
    )
    if (errors.length === 0) report.pass('no console errors or warnings during this load')
    else report.info('console errors/warnings during this load', errors.length + ': ' + clip(errors[0], 160))
    const subwsLogs = freshConsole.filter((line) => line.includes('sub-workspace') || line.includes('subws'))
    if (subwsLogs.length > 0) {
      report.info('plugin console lines', subwsLogs.slice(0, 4).map((line) => clip(line, 140)).join(' | '))
    }
    const freshRequests = session.networkSince(mark)
    report.info('network requests during this load', freshRequests.length)

    const summary = report.print()
    if (args.has('keep')) {
      console.log('')
      console.log('(--keep: browser session left open is not supported; the page stays as it is)')
    }
    return summary.failed === 0 ? 0 : 1
  } finally {
    session.close()
  }
})
