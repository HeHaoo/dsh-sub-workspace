/**
 * Host-API helpers: read the plugin's three routes the way the browser half
 * does, and report them uniformly.
 *
 * Replaces check.mjs / check2.mjs / verify.mjs / state.mjs / probe.mjs /
 * probe2.mjs / probe3.mjs / getbundle.mjs / probe_inside.mjs, and the host half
 * of fullcheck.mjs.
 *
 * All reads here are side-effect free: no function in this module mutates state.
 *
 * @module dsh-sub-workspace/scripts/verify/lib/api
 */

import { request } from './env.mjs'

/** Route paths published by lib/routes.js. */
export const ROUTE_LIST = '/api/sub-workspace/list'
export const ROUTE_MUTATE = '/api/sub-workspace/mutate'
export const ROUTE_CHECK = '/api/sub-workspace/check'

/** The package name this plugin is served under. */
export const PLUGIN_BUNDLE_ID = 'dsh-sub-workspace/client.js'

/** GET /api/sub-workspace/list. */
export function list(port, secret) {
  return request(ROUTE_LIST, { port, secret })
}

/** GET /api/sub-workspace/check?path=… (read-only: it never grants anything). */
export function checkPath(port, secret, path) {
  return request(ROUTE_CHECK + '?path=' + encodeURIComponent(path), { port, secret })
}

/**
 * POST /api/sub-workspace/mutate.
 * MUTATING: only call it from a script that says so in its header.
 */
export function mutate(port, secret, body) {
  return request(ROUTE_MUTATE, { port, secret, method: 'POST', body })
}

/**
 * Fetch the list route and summarize the payload shape.
 *
 * @returns {{ status: number, ok: boolean, workspaces: object[], storePath?: string, registry?: string, raw: string }}
 */
export async function listSummary(port, secret) {
  const response = await list(port, secret)
  const data = response.json
  return {
    status: response.status,
    ok: response.status === 200 && data !== undefined && Array.isArray(data.workspaces),
    workspaces: data !== undefined && Array.isArray(data.workspaces) ? data.workspaces : [],
    storePath: data === undefined ? undefined : data.storePath,
    registry: data === undefined ? undefined : data.registry,
    raw: response.text,
  }
}

/** Fetch the app shell HTML. */
export function indexHtml(port, secret) {
  return request('/', { port, secret })
}

/**
 * Find the URL the app shell loads this plugin's client bundle from.
 *
 * The shipped bundles are served from a `/plugins/??a/client.js,b/client.js&rev=…`
 * mega-request whose query string the shell hardcodes, so the only reliable way
 * to fetch ours is to read it out of the served HTML (a bare
 * `/plugins/??dsh-sub-workspace/client.js` 404s — the `rev` is mandatory).
 *
 * @returns {Promise<{ url?: string, html: string, error?: string }>}
 */
export async function discoverClientBundleUrl(port, secret) {
  const shell = await indexHtml(port, secret)
  const html = shell.text
  if (shell.status !== 200) return { html, error: 'app shell returned HTTP ' + shell.status }
  const pattern = new RegExp('["\']([^"\']*' + PLUGIN_BUNDLE_ID.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^"\']*)["\']', 'g')
  const candidates = []
  for (const match of html.matchAll(pattern)) {
    const raw = match[1].replaceAll('&amp;', '&')
    if (raw !== '' && !candidates.includes(raw)) candidates.push(raw)
  }
  if (candidates.length === 0) {
    return { html, error: 'the served shell does not reference ' + PLUGIN_BUNDLE_ID }
  }
  // Prefer the shortest match: the giant combined bundle also contains the id.
  candidates.sort((left, right) => left.length - right.length)
  return { url: candidates[0].startsWith('/') ? candidates[0] : '/' + candidates[0], html }
}

/**
 * Fetch this plugin's client bundle, discovering its URL from the app shell.
 *
 * @returns {{ status: number, text: string, url?: string, error?: string }}
 */
export async function clientBundle(port, secret, overrideUrl) {
  const discovered = overrideUrl === undefined ? await discoverClientBundleUrl(port, secret) : { url: overrideUrl }
  if (discovered.url === undefined) {
    return { status: 0, text: '', error: discovered.error }
  }
  const response = await request(discovered.url, { port, secret, timeoutMs: 30000 })
  return { status: response.status, text: response.text, url: discovered.url, error: discovered.error }
}
