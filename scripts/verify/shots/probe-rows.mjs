#!/usr/bin/env node
/**
 * Probe: enumerate every real sidebar row shape in the live DSH page.
 *
 * READ-ONLY. Opens the authenticated page and groups every `.bw-row` by its
 * class string, dumping the structural make-up of each variant (children,
 * attributes, computed padding-left, presence of icon / count / label /
 * chevron / svg). This is what the decoration filter is based on, so it must be
 * measured instead of assumed.
 *
 * Usage: node scripts/verify/shots/probe-rows.mjs [--port 52524] [--cdp-port 9334]
 */
import { readAuthSecret, dshPort, cdpPort, parseArgs, run } from '../lib/env.mjs'
import { openAuthenticatedPage } from '../lib/cdp.mjs'

const args = parseArgs()
const port = dshPort(args.get('port'))
const debugPort = cdpPort(args.get('cdp-port'))

const PROBE = '(' + String("function () {\n  function classOf(node) {\n    var cls = node.className;\n    if (typeof cls === 'string') return cls.trim()\n    if (cls && typeof cls.baseVal === 'string') return cls.baseVal.trim()\n    return ''\n  }\n  function describe(node) {\n    if (!node || node.nodeType !== 1) return null\n    var children = [].slice.call(node.children).map(function (child) {\n      var cls = classOf(child)\n      return child.tagName.toLowerCase() + (cls ? '.' + cls.split(' ').filter(Boolean).join('.') : '')\n    })\n    var cs = getComputedStyle(node)\n    var attrs = {}\n    for (var i = 0; i < node.attributes.length; i += 1) {\n      var a = node.attributes[i]\n      if (a.name === 'class' || a.name === 'style') continue\n      attrs[a.name] = String(a.value).slice(0, 80)\n    }\n    return {\n      tag: node.tagName.toLowerCase(),\n      cls: classOf(node),\n      attrs: attrs,\n      children: children,\n      childCount: node.children.length,\n      text: (node.textContent || '').trim().slice(0, 60),\n      paddingLeft: cs.paddingLeft,\n      display: cs.display,\n      role: node.getAttribute('role'),\n      hasIcon: node.querySelector('.bw-row-icon') !== null,\n      hasCount: node.querySelector('.bw-row-count') !== null,\n      hasLabel: node.querySelector('.bw-row-label') !== null,\n      hasChevron: node.querySelector('.bw-chevron') !== null,\n      hasSvg: node.querySelector('svg') !== null,\n      hasTrigger: node.querySelector('[data-subworkspace-trigger]') !== null\n    }\n  }\n  var out = {}\n  var tokens = {}\n  var all = [].slice.call(document.querySelectorAll('*'))\n  all.forEach(function (node) {\n    var cls = classOf(node)\n    if (!cls) return\n    cls.split(' ').filter(Boolean).forEach(function (token) {\n      if (token.indexOf('bw-') !== 0) return\n      tokens[token] = (tokens[token] || 0) + 1\n    })\n  })\n  out.tokens = tokens\n  var rows = [].slice.call(document.querySelectorAll('.bw-row'))\n  var groups = {}\n  rows.forEach(function (row) {\n    var key = classOf(row) + ' | role=' + row.getAttribute('role')\n    if (!groups[key]) groups[key] = { count: 0, samples: [] }\n    groups[key].count += 1\n    if (groups[key].samples.length < 2) groups[key].samples.push(describe(row))\n  })\n  out.rowGroups = groups\n  out.rowTotal = rows.length\n  var claim = {}\n  ;['bw-session-row', 'bw-sgroup-row', 'bw-row-icon', 'bw-row-count', 'bw-row-label', 'bw-chevron'].forEach(function (token) {\n    claim[token] = document.querySelectorAll('.' + token).length\n  })\n  out.claimSelectors = claim\n  out.officialRows = document.querySelectorAll('[data-row-key^=\"workspace:\"]').length\n  out.anyRowKey = [].slice.call(document.querySelectorAll('[data-row-key]')).slice(0, 10).map(function (node) {\n    return { key: node.getAttribute('data-row-key'), cls: classOf(node) }\n  })\n  out.allTriggers = document.querySelectorAll('[data-subworkspace-trigger]').length\n  out.treeitems = [].slice.call(document.querySelectorAll('[role=\"treeitem\"]')).length\n  out.treeitemsWithoutBwRow = [].slice.call(document.querySelectorAll('[role=\"treeitem\"]')).filter(function (node) {\n    return classOf(node).split(' ').indexOf('bw-row') === -1\n  }).length\n  out.triggersOnNonBwRow = [].slice.call(document.querySelectorAll('[data-subworkspace-trigger]')).filter(function (node) {\n    var row = node.parentElement\n    return !row || classOf(row).split(' ').indexOf('bw-row') === -1\n  }).length\n  return out\n}") + ')()'

await run(async () => {
  const { secret } = readAuthSecret()
  const { session } = await openAuthenticatedPage({ port, cdpPort: debugPort, secret })
  try {
    const result = await session.evaluate(PROBE)
    console.log(JSON.stringify(result, null, 2))
    return 0
  } finally {
    session.close()
  }
})
