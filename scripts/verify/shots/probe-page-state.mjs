#!/usr/bin/env node
/**
 * Probe: confirm the shared debug tab was left healthy after an injection run
 * (no leftover test triggers, no stray panel, the installed copy still intact).
 *
 * READ-ONLY.
 *
 * Usage: node scripts/verify/shots/probe-page-state.mjs [--port 52524] [--cdp-port 9334]
 */
import { readAuthSecret, dshPort, cdpPort, parseArgs, run } from '../lib/env.mjs'
import { openAuthenticatedPage } from '../lib/cdp.mjs'

const args = parseArgs()
const port = dshPort(args.get('port'))
const debugPort = cdpPort(args.get('cdp-port'))
const PROBE = '(function () {' + "\n  function classOf(node) {\n    var cls = node.className;\n    return typeof cls === 'string' ? cls.trim() : ''\n  }\n  var rows = [].slice.call(document.querySelectorAll('.bw-row'))\n  var out = { rowTotal: rows.length, workspace: 0, session: 0, sgroup: 0, installedTriggers: 0, testTriggers: 0, panels: 0, styleTags: document.querySelectorAll('style[data-plugin=\"dsh-sub-workspace\"]').length }\n  rows.forEach(function (row) {\n    var c = classOf(row).split(' ')\n    if (c.indexOf('bw-session-row') !== -1) out.session += 1\n    else if (c.indexOf('bw-sgroup-row') !== -1) out.sgroup += 1\n    else out.workspace += 1\n  })\n  out.installedTriggers = document.querySelectorAll('[data-subworkspace-trigger]').length\n  out.testTriggers = document.querySelectorAll('[data-swstest-trigger]').length\n  out.panels = document.querySelectorAll('.sws-panel').length\n  return out\n" + '})()'

await run(async () => {
  const { secret } = readAuthSecret()
  const { session } = await openAuthenticatedPage({ port, cdpPort: debugPort, secret })
  try {
    console.log(JSON.stringify(await session.evaluate(PROBE), null, 2))
    return 0
  } finally {
    session.close()
  }
})
