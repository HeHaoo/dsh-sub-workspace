#!/usr/bin/env node
/**
 * Run the whole verification toolset and print one aggregate verdict.
 *
 * Each check runs as its own child process so a crash, a precondition miss or a
 * hung browser cannot take the others down. Exit codes are propagated:
 * 0 = all passed, 1 = at least one check failed, 2 = a precondition was missing
 * (nothing failed, but nothing could be proven either).
 *
 * Usage:
 *   node scripts/verify/run-all.mjs [--port 52524] [--cdp-port 9334]
 *                                   [--only api,routes] [--skip cdp]
 *                                   [--verbose]
 *
 * Checks, cheap and offline-safe first:
 *   api      api-check.mjs      host routes over HTTP          (needs DSH)
 *   routes   routes-check.mjs   route contract, in-process     (needs lib/)
 *   sandbox  sandbox-check.mjs  policy decoration              (needs lib/ + DSH)
 *   cdp      dom-check.mjs      real sidebar DOM               (needs DSH + Chrome)
 *   inject   inject-check.mjs   clean-room client.js run       (needs DSH + Chrome)
 *
 * @module dsh-sub-workspace/scripts/verify/run-all
 */

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { cdpPort, dshPort, parseArgs } from './lib/env.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = parseArgs()
const port = dshPort(args.get('port'))
const debugPort = cdpPort(args.get('cdp-port'))
const verbose = args.has('verbose')

const ALL = [
  { id: 'api', script: 'api-check.mjs', what: 'host routes over HTTP', needs: 'DSH on :' + port },
  { id: 'routes', script: 'routes-check.mjs', what: 'route contract, in-process fixture', needs: 'lib/' },
  { id: 'sandbox', script: 'sandbox-check.mjs', what: 'sandbox policy decoration', needs: 'lib/ + DSH' },
  { id: 'cdp', script: 'dom-check.mjs', what: 'real sidebar DOM', needs: 'DSH + Chrome --remote-debugging-port=' + debugPort },
  { id: 'inject', script: 'inject-check.mjs', what: 'clean-room client.js run', needs: 'DSH + Chrome --remote-debugging-port=' + debugPort },
]

function select() {
  const only = args.get('only')
  const skip = args.get('skip')
  let chosen = ALL
  if (only !== undefined) {
    const wanted = String(only).split(',').map((entry) => entry.trim()).filter(Boolean)
    chosen = chosen.filter((check) => wanted.includes(check.id))
  }
  if (skip !== undefined) {
    const unwanted = String(skip).split(',').map((entry) => entry.trim()).filter(Boolean)
    chosen = chosen.filter((check) => !unwanted.includes(check.id))
  }
  return chosen
}

/** Run one check script, capturing its output. */
function runCheck(check) {
  const extra = []
  if (check.id === 'api' || check.id === 'routes' || check.id === 'sandbox') extra.push('--port', String(port))
  if (check.id === 'cdp' || check.id === 'inject') extra.push('--port', String(port), '--cdp-port', String(debugPort))
  const child = spawn(process.execPath, [join(HERE, check.script), ...extra], {
    cwd: HERE,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  return new Promise((resolve) => {
    child.on('close', (code) => resolve({ code: code === null ? 1 : code, stdout, stderr }))
  })
}

const selected = select()
if (selected.length === 0) {
  console.error('no checks selected')
  process.exitCode = 2
} else {
  console.log('dsh-sub-workspace verification: ' + selected.length + ' check(s)')
  console.log('  DSH ' + 'http://127.0.0.1:' + port + ' | CDP port ' + debugPort)
  console.log('')

  const results = []
  for (const check of selected) {
    const startedAt = Date.now()
    console.log('--- ' + check.id + ': ' + check.what + '  (' + check.needs + ')')
    const result = await runCheck(check)
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
    results.push({ check, result, elapsed })
    const lines = (result.stdout + result.stderr).split('\n')
    const summaryLine = lines.find((line) => line.startsWith('summary:'))
    const verdict = result.code === 0 ? 'PASS' : result.code === 2 ? 'SKIP' : 'FAIL'
    console.log('    ' + verdict + '  ' + (summaryLine === undefined ? '(no summary line)' : summaryLine.trim()) + '  [' + elapsed + 's]')
    if (verdict !== 'PASS') {
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.startsWith('FAIL ') || trimmed.startsWith('[precondition]') || trimmed.startsWith('[error]')) {
          console.log('      ' + trimmed.slice(0, 260))
        }
      }
    }
    if (verbose) {
      console.log('')
      console.log(result.stdout.trimEnd())
      if (result.stderr.trim() !== '') console.log(result.stderr.trimEnd())
      console.log('')
    }
    console.log('')
  }

  const failed = results.filter((entry) => entry.result.code === 1)
  const skipped = results.filter((entry) => entry.result.code === 2)
  const passed = results.filter((entry) => entry.result.code === 0)

  console.log('=== overall ===')
  console.log('  passed : ' + passed.length + '/' + results.length)
  if (failed.length > 0) console.log('  failed : ' + failed.map((entry) => entry.check.id).join(', '))
  if (skipped.length > 0) console.log('  skipped: ' + skipped.map((entry) => entry.check.id).join(', ') + ' (precondition missing, see above)')
  if (failed.length === 0 && skipped.length === 0) {
    console.log('  verdict: every check passed against a live DSH')
    process.exitCode = 0
  } else if (failed.length > 0) {
    process.exitCode = 1
  } else {
    process.exitCode = 2
  }
}
