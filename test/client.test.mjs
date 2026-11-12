/**
 * Client-half behaviour tests with a minimal DOM stub.
 *
 * The client half is DOM decoration, so these tests assert the invariants that
 * decide whether the feature works at all. The trigger is an INLINE BUTTON this
 * plugin appends to the end of a workspace row — NOT an item injected into the
 * host's right-click menu (that approach was abandoned: the host menu is a React
 * portal that rebuilds its children, so an injected item can be dropped
 * mid-interaction; see the decorateRow docblock in lib/client.js).
 *
 *   - ONLY real workspace rows are decorated — the sidebar interleaves workspace,
 *     folder, session and session-group rows in one tree, and a session title is
 *     user text that can equal a workspace name (the reported bug: 17 sessions
 *     titled "WorkBuddy" gained a 附属 button);
 *   - a row's workspace is identified from structure and the host's own React
 *     props, never from its label text alone;
 *   - an ambiguous label decorates nothing rather than the wrong workspace;
 *   - the inline trigger survives React rebuilds (the MutationObserver path) and
 *     is restored for rows mounted after activation (the bounded poll);
 *   - clicking the trigger opens a panel that lists and mutates via the host API;
 *   - unloading leaves no trace (triggers, stylesheet, listeners all removed).
 *
 * The stub implements only the DOM surface this module touches, but its row
 * builders reproduce the REAL child structure of each row type, because that
 * structure is what decides whether a row is a workspace.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

// ---------------------------------------------------------------- DOM stub ---

class StubNode {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase()
    this.children = []
    this.parentNode = null
    this.attrs = {}
    this.listeners = new Map()
    this.style = {}
    this.textContent = ''
    this.className = ''
    this.isConnected = false
    this.offsetWidth = 300
    this.offsetHeight = 200
    this.disabled = false
    this.value = ''
  }
  getAttribute(name) {
    return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null
  }
  setAttribute(name, value) {
    this.attrs[name] = String(value)
  }
  removeAttribute(name) {
    delete this.attrs[name]
  }
  appendChild(child) {
    child.parentNode = this
    child.isConnected = this.isConnected || this === document.body
    this.children.push(child)
    return child
  }
  append(...nodes) {
    for (const node of nodes) this.appendChild(node)
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null
    this.children = []
    for (const node of nodes) this.appendChild(node)
  }
  remove() {
    if (this.parentNode !== null) {
      const at = this.parentNode.children.indexOf(this)
      if (at !== -1) this.parentNode.children.splice(at, 1)
      this.parentNode = null
    }
    this.isConnected = false
  }
  getBoundingClientRect() {
    return { left: 10, top: 20, right: 60, bottom: 36, width: 50, height: 16, x: 10, y: 20 }
  }
  contains(node) {
    if (node === this) return true
    return this.children.some((child) => child.contains?.(node) ?? child === node)
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(handler)
  }
  removeEventListener(type, handler) {
    const list = this.listeners.get(type)
    if (list === undefined) return
    const at = list.indexOf(handler)
    if (at !== -1) list.splice(at, 1)
  }
  dispatchEvent() {
    return true
  }
  /** Walk this subtree, returning nodes matching a predicate. */
  walk(predicate, out = []) {
    if (predicate(this)) out.push(this)
    for (const child of this.children) child.walk?.(predicate, out)
    return out
  }
  closest(selector) {
    let node = this
    while (node !== null) {
      if (matchesSimple(node, selector)) return node
      node = node.parentNode
    }
    return null
  }
  querySelector(selector) {
    return this.walk((node) => matchesSimple(node, selector).valueOf())[0] ?? null
  }
  querySelectorAll(selector) {
    return this.walk((node) => matchesSimple(node, selector))
  }
}

/** Only the selector shapes this module uses (class, attribute, role). */
function matchesSimple(node, selector) {
  if (node === null || typeof node !== 'object') return false
  // `.class[role="x"]` — the sidebar row selector is deliberately narrowed by
  // both class and role, so the stub must honor the compound form.
  const compound = /^\.([A-Za-z0-9_-]+)\[role="([^"]+)"\]$/.exec(selector)
  if (compound !== null) {
    const classes = String(node.className ?? '').split(/\s+/).filter(Boolean)
    return classes.includes(compound[1]) && node.getAttribute?.('role') === compound[2]
  }
  // bare tag name (`ul`, `li`, `span`) — the plugin queries these inside the panel.
  if (/^[a-z]+$/.test(selector)) return String(node.tagName ?? '').toLowerCase() === selector
  // `.class` — the panel is located by class, so the stub must match it.
  const classMatch = /^\.([A-Za-z0-9_-]+)$/.exec(selector)
  if (classMatch !== null) {
    const classes = String(node.className ?? '').split(/\s+/).filter(Boolean)
    return classes.includes(classMatch[1])
  }
  const roleMatch = /^\[role="([^"]+)"\]$/.exec(selector)
  if (roleMatch !== null) return node.getAttribute?.('role') === roleMatch[1]
  const attrMatch = /^\[([a-zA-Z-]+)\]$/.exec(selector)
  if (attrMatch !== null) return node.getAttribute?.(attrMatch[1]) !== null
  const prefixAttr = /^\[([a-zA-Z-]+)\^="([^"]*)"\]$/.exec(selector)
  if (prefixAttr !== null) {
    const value = node.getAttribute?.(prefixAttr[1])
    return typeof value === 'string' && value.startsWith(prefixAttr[2])
  }
  const tagged = /^\[([a-zA-Z-]+)="([^"]+)"\]$/.exec(selector)
  if (tagged !== null) {
    if (tagged[1] === 'data-plugin') return node.attrs?.[tagged[1]] === tagged[2]
    return node.getAttribute?.(tagged[1]) === tagged[2]
  }
  return false
}

const observers = []
const documentStub = {
  body: null,
  head: null,
  documentElement: null,
  listeners: new Map(),
  createElement(tag) {
    return new StubNode(tag)
  },
  querySelector(selector) {
    return documentStub.documentElement.querySelector(selector)
  },
  querySelectorAll(selector) {
    return documentStub.documentElement.querySelectorAll(selector)
  },
  addEventListener(type, handler) {
    if (!documentStub.listeners.has(type)) documentStub.listeners.set(type, [])
    documentStub.listeners.get(type).push(handler)
  },
  removeEventListener(type, handler) {
    const list = documentStub.listeners.get(type)
    if (list === undefined) return
    const at = list.indexOf(handler)
    if (at !== -1) list.splice(at, 1)
  },
  dispatchEvent(event) {
    for (const handler of documentStub.listeners.get(event.type) ?? []) handler(event)
    return true
  },
}

class StubMutationObserver {
  constructor(callback) {
    this.callback = callback
    observers.push(this)
  }
  observe() {}
  disconnect() {
    const at = observers.indexOf(this)
    if (at !== -1) observers.splice(at, 1)
  }
}

/** Drive every live observer once, like a React commit. */
function flushObservers() {
  for (const observer of [...observers]) observer.callback([], observer)
}

globalThis.document = documentStub
globalThis.MutationObserver = StubMutationObserver
globalThis.Node = StubNode
globalThis.KeyboardEvent = class {
  constructor(type, init) {
    this.type = type
    this.key = init?.key
  }
}
const timers = []
globalThis.window = {
  innerWidth: 1440,
  innerHeight: 900,
  requestAnimationFrame: (callback) => {
    callback()
    return 1
  },
  cancelAnimationFrame: () => {},
  // The plugin's bounded retry poll; tests drive it through `settle()`.
  setTimeout: (callback, delay) => {
    const handle = setTimeout(callback, delay)
    timers.push(handle)
    return handle
  },
  clearTimeout: (handle) => clearTimeout(handle),
}


/**
 * Load `lib/client.js` the way the DSH client loader does.
 *
 * The file is NOT an ES module: it is a classic script calling
 * `window.__ModuleLoader__.load({id, factory})`. Importing it with `import()`
 * throws — that exact failure crashed the app on first install, so this helper
 * doubles as the regression guard.
 */
async function loadClientModule(suffix = '') {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const path = fileURLToPath(new URL('../lib/client.js', import.meta.url))
  const source = readFileSync(path, 'utf8')
  if (/^\s*export\s/m.test(source)) {
    throw new Error('lib/client.js must not use ESM export syntax (the loader runs it as a classic script)')
  }
  let definition = null
  const loaderWindow = Object.assign({}, globalThis.window, {
    __ModuleLoader__: { load: (def) => { definition = def } },
  })
  const run = new Function(
    'window', 'document', 'MutationObserver', 'Node', 'KeyboardEvent', 'fetch',
    `${source}\n//# sourceURL=client.js${suffix}`,
  )
  run(loaderWindow, globalThis.document, globalThis.MutationObserver, globalThis.Node, globalThis.KeyboardEvent, globalThis.fetch)
  if (definition === null) throw new Error('client.js did not register itself with __ModuleLoader__')
  return definition.factory(() => ({}))
}

// ---------------------------------------------------------------- harness ---

/** Build a fresh document tree for one test. */
function resetDom() {
  observers.length = 0
  const root = new StubNode('html')
  const head = new StubNode('head')
  const body = new StubNode('body')
  root.appendChild(head)
  root.appendChild(body)
  head.isConnected = true
  body.isConnected = true
  documentStub.documentElement = root
  documentStub.head = head
  documentStub.body = body
  documentStub.listeners = new Map()
  return { root, head, body }
}

/**
 * Build one row exactly as `dsh-better-workspace` renders it.
 *
 * The stub has to reproduce the REAL child structure, because the plugin decides
 * what a row is from that structure (see `isWorkspaceRow` in lib/client.js).
 * Each shape below is copied from the host's renderers in
 * dsh-better-workspace/src/client.js and was re-checked against a live page:
 *
 *   workspace   chevron · icon · label · [count] · actions
 *   folder      chevron · icon · label · [count]            (no actions)
 *   session     icon · label · time · actions
 *   sgroup      chevron · label · [count]                   (no icon)
 *
 * @param {StubNode} body
 * @param {string} className - full class string, e.g. 'bw-row bw-session-row'
 * @param {string} label
 * @param {{parts?: {chevron?: boolean, icon?: boolean, count?: boolean,
 *                   time?: boolean, actions?: boolean}}} [options]
 */
function addRawRow(body, className, label, options = {}) {
  const parts = options.parts ?? {}
  const row = new StubNode('div')
  row.className = className
  row.setAttribute('role', 'treeitem')
  const span = (cls, text) => {
    const node = new StubNode('span')
    node.className = cls
    if (text !== undefined) node.textContent = text
    row.appendChild(node)
    return node
  }
  if (parts.chevron === true) span('bw-chevron bw-chevron-open')
  if (parts.icon === true) span('bw-row-icon')
  span('bw-row-label', label)
  if (parts.count === true) span('bw-row-count', '3')
  if (parts.time === true) span('bw-row-time', '2 分钟')
  if (parts.actions === true) {
    const actions = span('bw-row-actions')
    const button = new StubNode('button')
    button.className = 'bw-icon-btn'
    actions.appendChild(button)
  }
  body.appendChild(row)
  return row
}

/** A workspace row: chevron · icon · label · count · actions. */
function addRow(body, label) {
  return addRawRow(body, 'bw-row', label, {
    parts: { chevron: true, icon: true, count: true, actions: true },
  })
}

/** A session row (title is user text — may equal a workspace name). */
function addSessionRow(body, label) {
  return addRawRow(body, 'bw-row bw-session-row', label, {
    parts: { icon: true, time: true, actions: true },
  })
}

/** A session-group row inside a workspace. */
function addGroupRow(body, label) {
  return addRawRow(body, 'bw-row bw-sgroup-row', label, {
    parts: { chevron: true, count: true },
  })
}

/** A folder row: workspace-shaped, but no actions slot and not a workspace. */
function addFolderRow(body, label) {
  return addRawRow(body, 'bw-row', label, {
    parts: { chevron: true, icon: true, count: true },
  })
}

/**
 * Attach a React fiber the way React does, so the plugin can read the
 * `workspace` prop the host's own `WorkspaceRow` rendered the row from.
 */
function attachWorkspaceFiber(row, workspace) {
  function WorkspaceRow() {}
  row['__reactFiber$stub'] = { type: WorkspaceRow, memoizedProps: { workspace }, return: null }
  return row
}

/** Attach a `SessionRow` fiber: the real owner of a session row carries no workspace. */
function attachSessionFiber(row, node) {
  function SessionRow() {}
  row['__reactFiber$stub'] = { type: SessionRow, memoizedProps: { node, depth: 1, current: false }, return: null }
  return row
}

// NOTE: there is deliberately no addMenu / fireContextMenu helper here.
// The plugin does NOT inject an item into the host's [role="menu"]: that design
// was abandoned (a React portal rebuilds the menu's children, so an injected
// item can vanish mid-interaction). The trigger is an inline button appended to
// the row itself, and the only contextmenu handling is that button's own
// preventDefault/stopPropagation.

/** Minimal client context: effect runs the body and returns teardown. */
function clientCtx() {
  const effects = []
  return {
    effects,
    ctx: {
      effect: (callback, label) => {
        const disposer = callback()
        effects.push({ label, disposer })
        return disposer
      },
    },
  }
}

/** Install a fetch stub returning a fixed list + mutate responses. */
function stubFetch(responses) {
  const calls = []
  globalThis.fetch = async (path, init) => {
    calls.push({ path: String(path), init })
    const key = String(path)
    const handler = responses[key] ?? responses['*']
    const value = typeof handler === 'function' ? handler(init) : handler
    return {
      ok: value?.ok ?? true,
      status: value?.status ?? 200,
      text: async () => JSON.stringify(value?.body ?? {}),
    }
  }
  return calls
}

/** Let queued microtasks and rAF callbacks run (the plugin defers work). */
async function settle() {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

const LIST = {
  '/api/sub-workspace/list': {
    body: {
      workspaces: [
        { workspace: '/ws/alpha', id: 'id-alpha', title: 'alpha', roots: ['/aff/one'] },
        { workspace: '/ws/beta', id: 'id-beta', title: 'beta', roots: [] },
      ],
      storePath: '/store/affiliates.json',
    },
  },
}

// ------------------------------------------------------------------ tests ---

test('decorates a workspace row with a 附属 trigger', async () => {
  resetDom()
  stubFetch(LIST)
  const row = addRow(documentStub.body, 'alpha')

  const { ctx } = clientCtx()
  const { apply } = await loadClientModule('')
  apply(ctx)
  await settle()

  const triggers = row.querySelectorAll('[data-subworkspace-trigger]')
  assert.equal(triggers.length, 1, 'the workspace row must carry one trigger')
  assert.equal(triggers[0].textContent, '附属')
})

test('does not decorate a session row', async () => {
  resetDom()
  stubFetch(LIST)
  const row = addSessionRow(documentStub.body, 'some-session-title')

  const { ctx } = clientCtx()
  const { apply } = await loadClientModule('?case=unknown')
  apply(ctx)
  await settle()

  assert.equal(
    row.querySelectorAll('[data-subworkspace-trigger]').length,
    0,
    'a non-workspace row must not gain a dead trigger',
  )
})

test('does not decorate a session whose title equals a workspace basename', async () => {
  // The reported bug: every message listed as "WorkBuddy" was a SESSION row whose
  // title matched the WorkBuddy workspace name, and 17 of them gained a 附属
  // button. Same shape here: the session title is exactly the workspace basename
  // (and the title), and the row must stay untouched.
  resetDom()
  stubFetch(LIST)
  const session = addSessionRow(documentStub.body, 'alpha')
  const workspace = addRow(documentStub.body, 'alpha')

  const { ctx } = clientCtx()
  const { apply } = await loadClientModule('?case=label-collision')
  apply(ctx)
  await settle()

  assert.equal(
    session.querySelectorAll('[data-subworkspace-trigger]').length,
    0,
    'a session titled like a workspace is still a session',
  )
  assert.equal(
    workspace.querySelectorAll('[data-subworkspace-trigger]').length,
    1,
    'the real workspace row with the same label must still be decorated',
  )
})

test('does not decorate a session whose title equals a workspace title', async () => {
  resetDom()
  stubFetch({
    '/api/sub-workspace/list': {
      body: {
        workspaces: [
          { workspace: '/Users/me/Work/DshPlugins', id: 'id-dsh', title: 'DshPlugins', roots: [] },
        ],
        storePath: '/store/affiliates.json',
      },
    },
  })
  // A brand-new session is titled after its directory, so its row label is the
  // directory name — the exact collision the old label matcher fell for.
  const session = addSessionRow(documentStub.body, 'DshPlugins')
  const workspace = addRow(documentStub.body, 'DshPlugins')

  const { ctx } = clientCtx()
  const { apply } = await loadClientModule('?case=title-collision')
  apply(ctx)
  await settle()

  assert.equal(session.querySelectorAll('[data-subworkspace-trigger]').length, 0)
  assert.equal(workspace.querySelectorAll('[data-subworkspace-trigger]').length, 1)
})

test('does not decorate a session-group row or a folder row', async () => {
  resetDom()
  stubFetch(LIST)
  const group = addGroupRow(documentStub.body, 'alpha')
  const folder = addFolderRow(documentStub.body, 'alpha')

  const { ctx } = clientCtx()
  const { apply } = await loadClientModule('?case=group-and-folder')
  apply(ctx)
  await settle()

  assert.equal(group.querySelectorAll('[data-subworkspace-trigger]').length, 0, 'group rows carry no workspace')
  assert.equal(
    folder.querySelectorAll('[data-subworkspace-trigger]').length,
    0,
    'a folder row is not a workspace: it has no actions slot and no directory of its own',
  )
})

test('decorates a workspace row from the React workspace prop, not its label', async () => {
  // The host renders each workspace row from its own `workspace` prop. Reading
  // that prop is what makes the row identity independent of any visible text.
  resetDom()
  stubFetch(LIST)
  // Label deliberately unrelated to any title / basename.
  const row = addRow(documentStub.body, 'totally unrelated label')
  attachWorkspaceFiber(row, { workspaceId: 'id-beta', path: '/ws/beta', leaf: 'beta', title: 'beta' })

  const { ctx } = clientCtx()
  const { apply } = await loadClientModule('?case=fiber')
  apply(ctx)
  await settle()

  const triggers = row.querySelectorAll('[data-subworkspace-trigger]')
  assert.equal(triggers.length, 1, 'the fiber identifies the workspace')

  for (const handler of triggers[0].listeners.get('click') ?? []) {
    handler({ preventDefault() {}, stopPropagation() {} })
  }
  await settle()
  const panel = documentStub.body.querySelector('.sws-panel')
  assert.ok(panel, 'the panel must open')
  assert.match(panel.querySelector('.sws-path').textContent, /\/ws\/beta/)
})

test('a session row carrying a real SessionRow fiber is never decorated', async () => {
  // The session row's own React owner is SessionRow, whose props carry the
  // session — never a workspace — so the fiber cannot be mistaken for one. This
  // is the real page's shape for the 17 mis-decorated rows, which had a session
  // title equal to a workspace name.
  resetDom()
  stubFetch(LIST)
  const session = addSessionRow(documentStub.body, 'alpha')
  attachSessionFiber(session, { id: 'session-1', title: 'alpha', leaf: 'alpha' })
  const workspace = addRow(documentStub.body, 'alpha')
  attachWorkspaceFiber(workspace, { workspaceId: 'id-alpha', path: '/ws/alpha', leaf: 'alpha', title: 'alpha' })

  const { ctx } = clientCtx()
  const { apply } = await loadClientModule('?case=session-fiber')
  apply(ctx)
  await settle()

  assert.equal(session.querySelectorAll('[data-subworkspace-trigger]').length, 0)
  assert.equal(workspace.querySelectorAll('[data-subworkspace-trigger]').length, 1)
})

test('fails closed on an ambiguous label instead of decorating the wrong workspace', async () => {
  // Two workspaces can share a basename (/a/kafka and /b/kafka). Guessing would
  // offer write access to the wrong directory, so an ambiguous label decorates
  // nothing — a missing button is recoverable, a wrong one is not.
  resetDom()
  stubFetch({
    '/api/sub-workspace/list': {
      body: {
        workspaces: [
          { workspace: '/a/kafka', id: 'id-a', title: 'a/kafka', roots: [] },
          { workspace: '/b/kafka', id: 'id-b', title: 'b/kafka', roots: [] },
        ],
        storePath: '/store/affiliates.json',
      },
    },
  })
  const plain = addRow(documentStub.body, 'kafka')
  const withId = addRow(documentStub.body, 'kafka')
  withId.setAttribute('data-row-key', 'workspace:id-b')

  const { ctx } = clientCtx()
  const { apply } = await loadClientModule('?case=ambiguous')
  apply(ctx)
  await settle()

  assert.equal(
    plain.querySelectorAll('[data-subworkspace-trigger]').length,
    0,
    'an ambiguous label must not pick one of the two workspaces',
  )
  assert.equal(
    withId.querySelectorAll('[data-subworkspace-trigger]').length,
    1,
    'an explicit id is unambiguous and is still decorated',
  )
})

test('re-decorates after React rebuilds the row', async () => {
  resetDom()
  stubFetch(LIST)
  const row = addRow(documentStub.body, 'alpha')

  const { ctx } = clientCtx()
  const { apply } = await loadClientModule('?case=rebuild')
  apply(ctx)
  await settle()
  assert.equal(row.querySelectorAll('[data-subworkspace-trigger]').length, 1)

  // Simulate a React commit that drops our node from the row.
  for (const node of row.querySelectorAll('[data-subworkspace-trigger]')) node.remove()
  flushObservers()
  await settle()

  assert.equal(
    row.querySelectorAll('[data-subworkspace-trigger]').length,
    1,
    'the observer must restore the trigger',
  )
})

test('a row carrying the official data-row-key is also decorated', async () => {
  resetDom()
  stubFetch(LIST)
  const row = new StubNode('div')
  row.className = 'bw-row'
  row.setAttribute('role', 'treeitem')
  row.setAttribute('data-row-key', 'workspace:id-beta')
  const labelEl = new StubNode('span')
  labelEl.className = 'bw-row-label'
  labelEl.textContent = 'beta'
  row.appendChild(labelEl)
  documentStub.body.appendChild(row)

  const { ctx } = clientCtx()
  const { apply } = await loadClientModule('?case=official')
  apply(ctx)
  await settle()

  assert.equal(row.querySelectorAll('[data-subworkspace-trigger]').length, 1)
})

test('clicking the trigger opens a panel listing that workspace roots', async () => {
  resetDom()
  stubFetch({
    ...LIST,
    '/api/sub-workspace/mutate': { body: { workspace: '/ws/alpha', roots: ['/aff/one'] } },
  })
  const row = addRow(documentStub.body, 'alpha')

  const { ctx } = clientCtx()
  const { apply } = await loadClientModule('?case=open')
  apply(ctx)
  await settle()

  const trigger = row.querySelectorAll('[data-subworkspace-trigger]')[0]
  assert.ok(trigger, 'trigger must exist before clicking')
  for (const handler of trigger.listeners.get('click') ?? []) {
    handler({ preventDefault() {}, stopPropagation() {} })
  }
  await settle()

  const panel = documentStub.body.querySelector('.sws-panel')
  assert.ok(panel, 'the panel must be appended to body')
  // Labelled with the directory, not the display label.
  assert.match(panel.querySelector('.sws-path').textContent, /\/ws\/alpha/)
  const items = panel.querySelectorAll('li')
  const pathSpans = items.flatMap((item) => item.children).filter((child) => child.tagName === 'SPAN')
  assert.equal(pathSpans.length, 1)
  assert.equal(pathSpans[0].textContent, '/aff/one')
})

test('teardown removes triggers, panel, and listeners', async () => {
  resetDom()
  stubFetch(LIST)
  const row = addRow(documentStub.body, 'alpha')

  const { ctx, effects } = clientCtx()
  const { apply } = await loadClientModule('?case=teardown')
  apply(ctx)
  await settle()
  assert.equal(row.querySelectorAll('[data-subworkspace-trigger]').length, 1)

  for (const effect of effects) effect.disposer()

  assert.equal(
    documentStub.body.querySelectorAll('[data-subworkspace-trigger]').length,
    0,
    'teardown must remove every injected trigger',
  )
  assert.equal(observers.length, 0, 'teardown must disconnect the observer')
})

test('the client half is a classic script, not an ES module', async () => {
  // Regression guard: `export` here crashed the app on first install, because
  // the loader runs /client.js as a classic script.
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const source = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')
  assert.equal(/^\s*export\s/m.test(source), false, 'no ESM export allowed')
  assert.match(source, /window\.__ModuleLoader__\.load\(/, 'must register through __ModuleLoader__')
})

/**
 * The panel stylesheet, as installed into the stub document.
 *
 * Searched directly among <head> children rather than with a selector, because
 * the trick that makes this bug possible is CSS-level, not DOM-level.
 */
function installedStylesheet() {
  const nodes = documentStub.head.children.filter((child) => child.tagName === 'STYLE')
  return nodes.length === 0 ? '' : String(nodes[nodes.length - 1].textContent)
}

test('the panel stylesheet uses only tokens that exist in DSH', async () => {
  // The white-on-white regression: the sheet asked for
  // var(--dsw-alias-bg-elevated, #fff), a token DSH never defines, so the panel
  // silently painted #fff while the text used --dsw-alias-label-primary (#f9fafb
  // in the dark theme). Guard both halves: no phantom token may be referenced,
  // and the real surface recipe must be present.
  resetDom()
  stubFetch(LIST)
  addRow(documentStub.body, 'alpha')
  const { ctx } = clientCtx()
  const { apply } = await loadClientModule('?case=tokens-present')
  apply(ctx)
  await settle()

  const css = installedStylesheet()
  assert.notEqual(css, '', 'the stylesheet must be installed into <head>')

  for (const phantom of ['--dsw-alias-bg-elevated', '--dsw-alias-menu-surface-fill']) {
    assert.equal(css.includes('var(' + phantom), false, phantom + ' does not exist in DSH; referencing it falls back')
  }

  // Copied from the host menu material so the panel reads as a native popover.
  for (const token of [
    '--dsw-menu-surface-fill',
    '--dsw-menu-backdrop-filter',
    '--dsw-elevation-prominent',
    '--dsw-radius-lg',
    '--dsw-font-family',
    '--dsw-alias-label-primary',
  ]) {
    assert.ok(css.includes('var(' + token), 'the panel must use ' + token)
  }
})

test('no colour token carries a literal fallback', async () => {
  // A literal fallback is only used when the token is missing — which is exactly
  // how an undefined token turns into a hard-coded colour that breaks in the
  // opposite theme. Any fallback that is a colour is therefore a bug.
  resetDom()
  stubFetch(LIST)
  addRow(documentStub.body, 'alpha')
  const { ctx } = clientCtx()
  const { apply } = await loadClientModule('?case=no-colour-fallbacks')
  apply(ctx)
  await settle()

  const css = installedStylesheet()
  assert.notEqual(css, '', 'the stylesheet must be installed into <head>')
  const fallbacks = [...css.matchAll(/var\((--[a-z0-9-]+)\s*,\s*([^)]*)\)/gi)]
    .filter((match) => /#|\(\s*\d+\s*,|\b(?:rgb|rgba|hsl|hsla|oklch)\b/i.test(match[2]))
    .map((match) => match[0])
  assert.deepEqual(fallbacks, [], 'colour literals hidden in var() fallbacks: ' + fallbacks.join(', '))
})

test('the 附属 trigger is styled by class, not by inline colours', async () => {
  // Inline styles cannot follow a theme switch and were the second half of the
  // "does not look like DSH" problem (a bare 5px box at 75% opacity).
  resetDom()
  stubFetch(LIST)
  const row = addRow(documentStub.body, 'alpha')
  const { ctx } = clientCtx()
  const { apply } = await loadClientModule('?case=trigger-class')
  apply(ctx)
  await settle()

  const trigger = row.querySelectorAll('[data-subworkspace-trigger]')[0]
  assert.ok(trigger, 'trigger must exist')
  assert.equal(trigger.className, 'sws-trigger', 'trigger styling must come from the stylesheet')

  const inline = String(trigger.style.cssText ?? '')
  assert.equal(/opacity|colour|color|border|background/.test(inline), false,
    'no inline theme-dependent declarations allowed, found: ' + inline)

  const css = installedStylesheet()
  assert.ok(css.includes('.sws-trigger'), 'the stylesheet must define .sws-trigger')
  assert.ok(css.includes('--dsw-alias-label-secondary'), 'trigger text uses the host secondary label colour')
  assert.ok(css.includes('--dsw-alias-interactive-bg-hover'), 'trigger gets a hover fill like the host row buttons')
})

test('the path input advertises ~/ support', async () => {
  resetDom()
  stubFetch(LIST)
  const row = addRow(documentStub.body, 'alpha')
  const { ctx } = clientCtx()
  const { apply } = await loadClientModule('?case=placeholder')
  apply(ctx)
  await settle()

  const trigger = row.querySelectorAll('[data-subworkspace-trigger]')[0]
  for (const handler of trigger.listeners.get('click') ?? []) {
    handler({ preventDefault() {}, stopPropagation() {} })
  }
  await settle()

  const input = documentStub.body.querySelector('.sws-panel').querySelectorAll('input')[0]
  assert.ok(input, 'the panel must render a path input')
  assert.match(input.placeholder, /~\//, 'the placeholder must show the ~/ form')
})

test('decorates rows that mount AFTER activation (the poll fix)', async () => {
  // Regression: the plugin used to run once while the sidebar was still empty,
  // then never again, so no trigger ever appeared. The bounded poll must pick
  // rows up once they mount.
  resetDom()
  stubFetch(LIST)

  const { ctx } = clientCtx()
  const { apply } = await loadClientModule('?case=late-mount')
  apply(ctx)
  await settle()
  assert.equal(
    documentStub.body.querySelectorAll('[data-subworkspace-trigger]').length,
    0,
    'nothing to decorate before any row exists',
  )

  // The sidebar mounts now, after activation.
  const row = addRow(documentStub.body, 'alpha')
  // Let the poll run.
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 60))
    if (row.querySelectorAll('[data-subworkspace-trigger]').length > 0) break
  }

  assert.equal(
    row.querySelectorAll('[data-subworkspace-trigger]').length,
    1,
    'a row mounted after activation must still get its trigger',
  )
})
