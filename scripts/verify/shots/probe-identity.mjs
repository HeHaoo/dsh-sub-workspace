#!/usr/bin/env node
/**
 * Probe: for EVERY .bw-row, what does its React owner chain say it is, and does
 * the WorkspaceRow props carry the workspace directory?
 *
 * READ-ONLY. Decides whether the decoration filter may use (a) the row's owner
 * component name and (b) props.workspace.path as a structural, label-free
 * identity — and verifies the path matches the host list API's directory keys.
 *
 * Usage: node scripts/verify/shots/probe-identity.mjs [--port 52524] [--cdp-port 9334]
 */
import { readAuthSecret, dshPort, cdpPort, parseArgs, request, run } from '../lib/env.mjs'
import { openAuthenticatedPage } from '../lib/cdp.mjs'

const args = parseArgs()
const port = dshPort(args.get('port'))
const debugPort = cdpPort(args.get('cdp-port'))

const PROBE = '(function () {' + "\n  function classOf(node) {\n    var cls = node.className\n    if (typeof cls === 'string') return cls.trim()\n    if (cls && typeof cls.baseVal === 'string') return cls.baseVal.trim()\n    return ''\n  }\n  function fiberOf(node) {\n    var keys = Object.keys(node)\n    for (var i = 0; i < keys.length; i += 1) if (keys[i].indexOf('__reactFiber') === 0) return node[keys[i]]\n    return null\n  }\n  function chainOwners(node, limit) {\n    var current = fiberOf(node)\n    var owners = []\n    var hops = 0\n    while (current && hops < limit) {\n      var type = current.type\n      if (typeof type === 'function' && type.name) owners.push({ hop: hops, name: type.name })\n      current = current.return\n      hops += 1\n    }\n    return owners\n  }\n  function workspacePath(node) {\n    var current = fiberOf(node)\n    var hops = 0\n    while (current && hops < 5) {\n      var type = current.type\n      if (typeof type === 'function' && type.name === 'WorkspaceRow') {\n        var props = current.memoizedProps || {}\n        var ws = props.workspace || {}\n        return { path: ws.path, workspaceId: ws.workspaceId, leaf: ws.leaf, title: ws.title, subPrefix: ws.subPrefix, folderPath: ws.folderPath }\n      }\n      current = current.return\n      hops += 1\n    }\n    return null\n  }\n  var out = []\n  var rows = [].slice.call(document.querySelectorAll('.bw-row'))\n  rows.forEach(function (row) {\n    var classes = classOf(row).split(' ')\n    var labelEl = row.querySelector('.bw-row-label')\n    var label = labelEl === null ? '' : labelEl.textContent.trim()\n    var info = {\n      cls: classOf(row),\n      label: label,\n      owners: chainOwners(row, 3),\n      ws: workspacePath(row),\n      hasIcon: row.querySelector('.bw-row-icon') !== null,\n      hasActions: row.querySelector('.bw-row-actions') !== null,\n      hasChevron: row.querySelector('.bw-chevron') !== null,\n      hasCount: row.querySelector('.bw-row-count') !== null,\n      hasTime: row.querySelector('.bw-row-time') !== null,\n      tag: row.tagName.toLowerCase(),\n      role: row.getAttribute('role'),\n      ariaExpanded: row.getAttribute('aria-expanded'),\n      draggable: row.getAttribute('draggable')\n    }\n    out.push(info)\n  })\n  return out\n" + '})()'

await run(async () => {
  const { secret } = readAuthSecret()
  const listed = await request('/api/sub-workspace/list', { port, secret })
  const known = new Set((listed.json.workspaces || []).map((item) => item.workspace))
  const titles = new Set((listed.json.workspaces || []).map((item) => item.title))
  const bases = new Set((listed.json.workspaces || []).map((item) => String(item.workspace).split('/').filter(Boolean).pop()))
  console.log('host list: ' + known.size + ' workspace dir(s)')

  const { session } = await openAuthenticatedPage({ port, cdpPort: debugPort, secret })
  try {
    const rows = await session.evaluate(PROBE)
    const summary = {}
    for (const row of rows) {
      const owner = row.owners.length === 0 ? 'NONE' : row.owners[0].name
      const key = row.cls + ' | owner=' + owner
      if (summary[key] === undefined) {
        summary[key] = { count: 0, sample: row }
      }
      summary[key].count += 1
    }
    for (const [key, entry] of Object.entries(summary)) {
      const sample = entry.sample
      const ws = sample.ws
      console.log(JSON.stringify({
        key,
        count: entry.count,
        label: sample.label,
        wsPath: ws === null ? null : ws.path,
        pathIsKnownWorkspace: ws === null ? null : known.has(ws.path),
        wsId: ws === null ? null : ws.workspaceId,
        labelMatchesTitle: titles.has(sample.label),
        labelMatchesBasename: bases.has(sample.label),
        hasIcon: sample.hasIcon,
        hasActions: sample.hasActions,
        hasChevron: sample.hasChevron,
        hasCount: sample.hasCount,
        hasTime: sample.hasTime,
        tag: sample.tag,
        role: sample.role,
        ariaExpanded: sample.ariaExpanded,
      }))
    }
    // Cross-check: does every known workspace dir appear via fiber?
    const viaFiber = new Set(rows.filter((row) => row.ws !== null && row.ws.path).map((row) => row.ws.path))
    const missing = [...known].filter((dir) => !viaFiber.has(dir))
    console.log('workspace dirs reachable via fiber: ' + viaFiber.size + '/' + known.size)
    console.log('known dirs with no visible row: ' + JSON.stringify(missing))
    return 0
  } finally {
    session.close()
  }
})
