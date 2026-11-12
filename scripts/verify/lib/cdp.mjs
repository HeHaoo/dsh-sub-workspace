/**
 * Minimal Chrome DevTools Protocol client over the built-in WebSocket.
 *
 * Consolidates the raw WebSocket boilerplate that every one of the original
 * throwaway scripts (cdp.mjs, cdp2.mjs, dom.mjs, trace.mjs, ...) repeated by
 * hand: connect, id-correlated send, Runtime.evaluate with awaitPromise and
 * by-value returns, console/exception capture, cookie install, navigate.
 *
 * Preconditions: Chrome must have been started with
 *   --remote-debugging-port=9334 --user-data-dir=<some temp dir>
 * and must have at least one page target. Otherwise a PreconditionError is
 * thrown so the caller reports SKIP instead of a fake failure.
 *
 * @module dsh-sub-workspace/scripts/verify/lib/cdp
 */

import { authCookie, cdpPort, describeAuth, PreconditionError } from './env.mjs'

/** How long to wait for the page to mount after navigate() by default. */
export const DEFAULT_MOUNT_WAIT_MS = 15000

/** List the debugger targets Chrome currently exposes. */
export async function listTargets(port) {
  const resolved = cdpPort(port)
  const url = 'http://127.0.0.1:' + resolved + '/json/list'
  let response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(3000) })
  } catch (error) {
    throw new PreconditionError(
      'Chrome DevTools Protocol is not reachable at 127.0.0.1:' +
        resolved +
        ' — start Chrome with --remote-debugging-port=' +
        resolved +
        ' (' +
        (error && error.message ? error.message : error) +
        ')',
    )
  }
  if (!response.ok) {
    throw new PreconditionError('CDP /json/list returned HTTP ' + response.status + ' on port ' + resolved)
  }
  const targets = await response.json()
  if (!Array.isArray(targets)) throw new PreconditionError('CDP /json/list did not return an array')
  return targets
}

/** Pick the first page target, or refuse with an actionable message. */
export function pickPage(targets) {
  const page = targets.find((target) => target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string')
  if (page === undefined) {
    throw new PreconditionError(
      'CDP has no page target (' +
        targets.length +
        ' target(s): ' +
        targets.map((target) => target.type).join(', ') +
        ') — open ' +
        'a DSH tab in the debug Chrome window first',
    )
  }
  return page
}

/**
 * Connect to one page target.
 *
 * @returns a session object with send/evaluate/navigate/… and close().
 */
export async function connect(options = {}) {
  const targets = options.targets === undefined ? await listTargets(options.cdpPort) : options.targets
  const page = options.page === undefined ? pickPage(targets) : options.page
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new PreconditionError('CDP WebSocket open timed out')), 10000)
    ws.onopen = () => {
      clearTimeout(timer)
      resolve()
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new PreconditionError('CDP WebSocket failed to open: ' + page.webSocketDebuggerUrl))
    }
  })

  let nextId = 0
  const pending = new Map()
  const consoleLines = []
  const exceptions = []
  const networkUrls = []
  const startedAt = Date.now()

  ws.onmessage = (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    if (message.method === 'Runtime.consoleAPICalled') {
      const args = (message.params && message.params.args) || []
      consoleLines.push(
        '@' + (Date.now() - startedAt) + 'ms ' +
        (message.params && message.params.type ? message.params.type : 'log') +
          ': ' +
          args.map((arg) => (arg.value === undefined ? (arg.description === undefined ? '' : arg.description) : arg.value)).join(' '),
      )
    } else if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params && message.params.exceptionDetails ? message.params.exceptionDetails : {}
      exceptions.push({
        at: Date.now() - startedAt,
        text:
          (details.exception && details.exception.description) ||
          details.text ||
          'unknown exception',
      })
    } else if (message.method === 'Network.requestWillBeSent') {
      const url = message.params && message.params.request ? message.params.request.url : ''
      if (typeof url === 'string' && url !== '') networkUrls.push(url)
    }
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
  }

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('CDP ' + method + ' timed out'))
      }, 30000)
      pending.set(id, (message) => {
        clearTimeout(timer)
        if (message.error !== undefined) {
          reject(new Error('CDP ' + method + ': ' + JSON.stringify(message.error)))
          return
        }
        resolve(message.result === undefined ? {} : message.result)
      })
      ws.send(JSON.stringify({ id, method, params }))
    })

  const session = {
    page,
    consoleLines,
    exceptions,
    networkUrls,
    send,
    /**
     * Record how far the event buffers have advanced, so a caller can ignore
     * anything a PREVIOUS page left in them and only judge its own load.
     */
    mark() {
      return { console: consoleLines.length, exceptions: exceptions.length, network: networkUrls.length }
    },
    /** Exceptions raised after `mark()`, as `{ at, text }`. */
    exceptionsSince(mark) {
      return mark === undefined ? exceptions.slice() : exceptions.slice(mark.exceptions)
    },
    /** Console lines after `mark()`. */
    consoleSince(mark) {
      return mark === undefined ? consoleLines.slice() : consoleLines.slice(mark.console)
    },
    /** Network URLs after `mark()`. */
    networkSince(mark) {
      return mark === undefined ? networkUrls.slice() : networkUrls.slice(mark.network)
    },
    /** Evaluate an expression in the page; returns the by-value result. */
    async evaluate(expression) {
      const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      })
      const details = result.exceptionDetails
      if (details !== undefined) {
        return {
          __error: true,
          text: details.text,
          detail: (details.exception && details.exception.description) || undefined,
        }
      }
      return result.result === undefined ? undefined : result.result.value
    },
    /** Enable the domains the verification scripts need. */
    async enable(domains = ['Runtime', 'Page']) {
      for (const domain of domains) await send(domain + '.enable')
    },
    /** Install the DSH auth cookie for the given port + secret. */
    async setAuthCookie(port, secret) {
      const cookie = authCookie(port, secret)
      await send('Network.setCookie', {
        name: cookie.name,
        value: cookie.value,
        domain: '127.0.0.1',
        path: '/',
        httpOnly: true,
        sameSite: 'Strict',
      })
      return describeAuth(cookie)
    },
    /** Navigate and wait for the SPA to mount. */
    async navigate(url, waitMs = DEFAULT_MOUNT_WAIT_MS) {
      await send('Page.navigate', { url })
      await new Promise((resolve) => setTimeout(resolve, waitMs))
    },
    close() {
      try {
        ws.close()
      } catch {
        /* already gone */
      }
    },
  }

  return session
}

/**
 * Connect, authenticate and land on the DSH web UI — the sequence every
 * read-the-real-page check needs. Returns the session pre-navigated.
 */
export async function openAuthenticatedPage(options = {}) {
  const { secret } = options
  const port = options.port
  const session = await connect(options)
  await session.enable(
    options.domains === undefined ? ['Runtime', 'Page', 'Network'] : options.domains,
  )
  const label = await session.setAuthCookie(port, secret)
  // Mark AFTER enabling the domains but BEFORE navigating: whatever the
  // previous page left in the event buffers is then excluded from the checks.
  const mark = session.mark()
  await session.navigate(options.url === undefined ? 'http://127.0.0.1:' + port + '/' : options.url, options.waitMs)
  return { session, authLabel: label, mark }
}
