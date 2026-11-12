/**
 * Shared configuration, authentication and reporting helpers for the
 * dsh-sub-workspace verification scripts.
 *
 * SECURITY: no credential is hardcoded here. The browser-session signing secret
 * is resolved, in order, from:
 *
 *   1. the DSH_AUTH_SECRET environment variable;
 *   2. records['client-connection/browser-session'].payload.secret inside
 *      ${DSH_HOME}/.credentials.yaml (~/.dsh/.credentials.yaml by default),
 *      parsed with a ~30 line scanner so no YAML dependency is added.
 *
 * The secret is never printed, and neither is the cookie derived from it: the
 * helpers below only ever expose the cookie NAME.
 *
 * @module dsh-sub-workspace/scripts/verify/lib/env
 */

import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Directory of the verification scripts (dsh-sub-workspace/scripts/verify). */
export const VERIFY_DIR = resolve(HERE, '..')
/** Root of the dsh-sub-workspace plugin. */
export const PLUGIN_ROOT = resolve(HERE, '..', '..', '..')
/** DSH web port used when neither DSH_PORT nor PORT is set. */
export const DEFAULT_PORT = 52524
/** Chrome DevTools Protocol port used when DSH_CDP_PORT is not set. */
export const DEFAULT_CDP_PORT = 9334
/** Credentials record key that holds the browser-session signing secret. */
export const RECORD_KEY = 'client-connection/browser-session'

/**
 * Something the machine must provide before a check can run: DSH is not
 * listening, Chrome's debug port is closed, no credentials are readable.
 * Scripts exit with code 2 for this — a SKIP, never a failed check.
 */
export class PreconditionError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PreconditionError'
    this.exitCode = 2
  }
}

/**
 * Flags that never take a value. Everything else may be written either as
 * `--key=value` or as `--key value`; a bare `--flag` is a boolean.
 */
const BOOLEAN_FLAGS = new Set([
  'json',
  'quiet',
  'keep',
  'verbose',
  'skip-live',
  'no-reload',
  'open-panel',
  'help',
])

/**
 * Tiny argv parser: `--flag`, `--key=value`, `--key value`, and bare
 * positionals.
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const flags = new Set()
  const values = new Map()
  const positional = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      if (eq !== -1) {
        values.set(arg.slice(2, eq), arg.slice(eq + 1))
        continue
      }
      const name = arg.slice(2)
      const next = argv[index + 1]
      if (!BOOLEAN_FLAGS.has(name) && next !== undefined && !next.startsWith('--')) {
        values.set(name, next)
        index += 1
        continue
      }
      flags.add(name)
    } else {
      positional.push(arg)
    }
  }
  return {
    flags,
    values,
    positional,
    has: (name) => flags.has(name),
    get: (name, fallback) => (values.has(name) ? values.get(name) : fallback),
  }
}

function toPort(candidate) {
  const text = String(candidate).trim()
  const port = Number(text)
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
    throw new PreconditionError('invalid port: ' + JSON.stringify(text))
  }
  return port
}

/** Resolve the DSH web port: explicit arg, DSH_PORT, PORT, then 52524. */
export function dshPort(value) {
  for (const candidate of [value, process.env.DSH_PORT, process.env.PORT, DEFAULT_PORT]) {
    if (candidate === undefined || candidate === null || String(candidate).trim() === '') continue
    return toPort(candidate)
  }
  throw new PreconditionError('no DSH port resolved')
}

/** Resolve the Chrome CDP port: explicit arg, DSH_CDP_PORT, CDP_PORT, then 9334. */
export function cdpPort(value) {
  for (const candidate of [value, process.env.DSH_CDP_PORT, process.env.CDP_PORT, DEFAULT_CDP_PORT]) {
    if (candidate === undefined || candidate === null || String(candidate).trim() === '') continue
    return toPort(candidate)
  }
  throw new PreconditionError('no CDP port resolved')
}

/** Base URL of the local DSH web server. */
export function dshBase(port) {
  return 'http://127.0.0.1:' + dshPort(port)
}

/** Absolute path of the credentials document, honoring DSH_HOME. */
export function credentialsFile() {
  const home = process.env.DSH_HOME === undefined ? '' : String(process.env.DSH_HOME).trim()
  return resolve(home === '' ? join(homedir(), '.dsh') : home, '.credentials.yaml')
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Turn one YAML scalar into a bare string (quotes and trailing comment removed). */
function stripYamlScalar(raw) {
  let text = String(raw === undefined || raw === null ? '' : raw).trim()
  if (text === '') return ''
  const quote = text.charAt(0)
  if (quote === '"' || quote === "'") {
    const end = text.indexOf(quote, 1)
    if (end !== -1) return text.slice(1, end)
  }
  const comment = text.indexOf(' #')
  if (comment !== -1) text = text.slice(0, comment).trim()
  return text
}

/**
 * Extract records['client-connection/browser-session'].payload.secret from the
 * DSH credentials document, using indentation only — no YAML dependency.
 *
 * The document is a fixed-shape file written by DSH itself:
 *
 *   records:
 *     client-connection/browser-session:
 *       kind: grant
 *       payload:
 *         version: 1
 *         secret: <base64url>
 *
 * @returns the secret, or undefined when the record is absent/empty.
 */
export function parseCredentialsSecret(text) {
  const source = String(text === undefined || text === null ? '' : text)
  const lines = source.split(/\r?\n/)
  const keyPattern = new RegExp('^\\s*[\'"]?' + escapeRegExp(RECORD_KEY) + '[\'"]?\\s*:')
  const keyLine = lines.findIndex((line) => !/^\s*#/.test(line) && keyPattern.test(line))
  const found = []
  if (keyLine !== -1) {
    const keyIndent = lines[keyLine].length - lines[keyLine].trimStart().length
    for (let index = keyLine + 1; index < lines.length; index += 1) {
      const line = lines[index]
      if (line.trim() === '' || /^\s*#/.test(line)) continue
      const indent = line.length - line.trimStart().length
      if (indent <= keyIndent) break
      const match = /^\s*secret\s*:\s*(.+?)\s*$/.exec(line)
      if (match !== null) found.push(match[1])
    }
  }
  if (found.length === 0) {
    const fallback = new RegExp(escapeRegExp(RECORD_KEY) + ':[\\s\\S]*?\\n\\s*secret\\s*:\\s*(.+)')
    const match = fallback.exec(source)
    if (match !== null) found.push(match[1])
  }
  for (const raw of found) {
    const value = stripYamlScalar(raw)
    if (value !== '') return value
  }
  return undefined
}

/**
 * Resolve the browser-session signing secret.
 *
 * @returns {{ secret: string, source: string }} source is a human label only.
 * @throws {PreconditionError} when neither the env var nor the file has it.
 */
export function readAuthSecret(options = {}) {
  const fromEnv = process.env.DSH_AUTH_SECRET === undefined ? '' : String(process.env.DSH_AUTH_SECRET).trim()
  if (fromEnv !== '') return { secret: fromEnv, source: 'env DSH_AUTH_SECRET' }
  const file = credentialsFile()
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    throw new PreconditionError(
      'no DSH_AUTH_SECRET, and ' + file + ' is unreadable: ' + (error && error.message ? error.message : error),
    )
  }
  const secret = parseCredentialsSecret(text)
  if (secret === undefined) {
    throw new PreconditionError(
      'no DSH_AUTH_SECRET, and ' + file + ' has no records[\'' + RECORD_KEY + '\'].payload.secret',
    )
  }
  if (options.required === false) return { secret, source: 'credentials file ' + file }
  return { secret, source: 'credentials file ' + file }
}

/** base64url without padding, exactly what the DSH auth cookie uses. */
function b64u(buffer) {
  return Buffer.from(buffer).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/**
 * Build the DSH browser-session auth cookie for one local port.
 *
 * Shape: dsh-auth-<b64u(sha256(authority))>=v1.<b64u(payload)>.<b64u(hmac)>
 * (identical to what the DSH web app sets, so the host accepts it).
 *
 * @returns {{ name: string, value: string, header: string, expiresAt: number }}
 */
export function authCookie(port, secret) {
  const resolved = dshPort(port)
  const authority = '127.0.0.1:' + resolved
  const key = Buffer.from(String(secret).replaceAll('-', '+').replaceAll('_', '/'), 'base64')
  const issuedAt = Date.now()
  const expiresAt = issuedAt + 86400 * 1000
  const payload = { version: 1, authority, issuedAt, expiresAt }
  const body = b64u(Buffer.from(JSON.stringify(payload), 'utf8'))
  const name = 'dsh-auth-' + b64u(createHash('sha256').update(authority).digest())
  const signature = b64u(createHmac('sha256', key).update(body).digest())
  const value = 'v1.' + body + '.' + signature
  return { name, value, header: name + '=' + value, expiresAt }
}

/** A printable, non-sensitive description of a cookie (never the value). */
export function describeAuth(auth) {
  return auth.name + ' (value withheld, ' + auth.header.length + ' chars)'
}

/**
 * One HTTP request against the local DSH server.
 * The Origin header matches the host/Origin fence; the cookie is only attached
 * when a secret is supplied.
 */
export async function request(path, options = {}) {
  const port = dshPort(options.port)
  const base = dshBase(port)
  const headers = Object.assign({ origin: base, accept: 'application/json' }, options.headers)
  if (options.secret !== undefined && options.secret !== null && options.secret !== '') {
    headers.cookie = authCookie(port, options.secret).header
  }
  const init = {
    method: options.method === undefined ? 'GET' : options.method,
    headers,
    signal: AbortSignal.timeout(options.timeoutMs === undefined ? 10000 : options.timeoutMs),
  }
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(options.body)
  }
  let response
  try {
    response = await fetch(base + path, init)
  } catch (error) {
    throw new PreconditionError(
      'DSH is not reachable at ' + base + ' (' + (error && error.message ? error.message : error) + ')',
    )
  }
  const text = await response.text()
  let json
  try {
    json = text === '' ? undefined : JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: response.status, text, json, url: base + path }
}

/** Shorten a string for log lines. */
export function clip(value, max = 200) {
  const text = String(value === undefined || value === null ? '' : value)
  return text.length <= max ? text : text.slice(0, max) + '…'
}

/** Uniform PASS/FAIL/SKIP output shared by every script. */
export function reporter(title) {
  const rows = []
  const add = (kind, name, detail) => {
    rows.push({ kind, name, detail: detail === undefined || detail === null ? '' : String(detail) })
  }
  return {
    pass: (name, detail) => add('PASS', name, detail),
    fail: (name, detail) => add('FAIL', name, detail),
    skip: (name, detail) => add('SKIP', name, detail),
    info: (name, detail) => add('INFO', name, detail),
    print() {
      const failed = rows.filter((row) => row.kind === 'FAIL').length
      const passed = rows.filter((row) => row.kind === 'PASS').length
      const skipped = rows.filter((row) => row.kind === 'SKIP').length
      console.log('')
      console.log('=== ' + title + ' ===')
      for (const row of rows) {
        const detail = row.detail === '' ? '' : ' — ' + row.detail
        console.log('  ' + row.kind.padEnd(4) + ' ' + row.name + detail)
      }
      console.log('')
      console.log('summary: ' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped')
      return { passed, failed, skipped }
    },
  }
}

/** Run a script body with uniform exit codes: 0 pass, 1 fail, 2 precondition. */
export async function run(main) {
  try {
    const code = await main()
    process.exitCode = typeof code === 'number' ? code : 0
  } catch (error) {
    if (error instanceof PreconditionError) {
      console.error('[precondition] ' + error.message)
      process.exitCode = error.exitCode
      return
    }
    console.error('[error] ' + (error && error.stack ? error.stack : String(error)))
    process.exitCode = 1
  }
}
