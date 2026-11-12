/**
 * Shared DOM probes for the DSH sidebar, as rendered by the real web app.
 *
 * One place for the selectors and the count/label queries that the original
 * throwaway scripts re-typed in every file (cdp.mjs, dom.mjs, diag.mjs,
 * fullcheck.mjs, trace.mjs, ...). Keep this file free of assertions: it only
 * reports what the page contains.
 *
 * @module dsh-sub-workspace/scripts/verify/lib/dom
 */

/** Workspace row drawn by `dsh-better-workspace`. */
export const WORKSPACE_ROW = '.bw-row[role="treeitem"]'
/** Workspace row drawn by the official sidebar (has data-row-key). */
export const OFFICIAL_ROW = '[data-row-key^="workspace:"]'
/** Row label element inside a `dsh-better-workspace` row. */
export const ROW_LABEL = '.bw-row-label'
/** The 「附属」 trigger this plugin appends to every decorated row. */
export const TRIGGER = '[data-subworkspace-trigger]'
/** The plugin's injected stylesheet. */
export const STYLE_TAG = 'style[data-plugin="dsh-sub-workspace"]'
/** The affiliate panel this plugin opens. */
export const PANEL = '.sws-panel'

/** Count the elements matching one selector, tolerating a broken page. */
export async function count(session, selector) {
  const value = await session.evaluate('document.querySelectorAll(' + JSON.stringify(selector) + ').length')
  return typeof value === 'number' ? value : 0
}

/** Every workspace row label currently in the DOM, in document order. */
export async function rowLabels(session) {
  const value = await session.evaluate(
    '[' +
      '...document.querySelectorAll(' +
      JSON.stringify(WORKSPACE_ROW) +
      ')' +
      '].map(function (row) {' +
      '  var label = row.querySelector(' +
      JSON.stringify(ROW_LABEL) +
      ');' +
      '  return label === null ? null : label.textContent.trim();' +
      '})',
  )
  return Array.isArray(value) ? value.filter((label) => typeof label === 'string' && label !== '') : []
}

/**
 * A single snapshot of everything the checks care about.
 *
 * @returns {{rows: number, triggers: number, styleTags: number, panels: number,
 *            officialRows: number, labels: string[]}}
 */
export async function snapshot(session) {
  const [rows, triggers, styleTags, panels, officialRows, labels] = [
    await count(session, WORKSPACE_ROW),
    await count(session, TRIGGER),
    await count(session, STYLE_TAG),
    await count(session, PANEL),
    await count(session, OFFICIAL_ROW),
    await rowLabels(session),
  ]
  return { rows, triggers, styleTags, panels, officialRows, labels }
}

/** Which rows carry the 「附属」 trigger, and which do not. */
export async function triggerCoverage(session) {
  const value = await session.evaluate(
    '[' +
      '...document.querySelectorAll(' +
      JSON.stringify(WORKSPACE_ROW) +
      ')' +
      '].map(function (row) {' +
      '  var label = row.querySelector(' +
      JSON.stringify(ROW_LABEL) +
      ');' +
      '  return {' +
      '    label: label === null ? null : label.textContent.trim(),' +
      '    hasTrigger: row.querySelector(' +
      JSON.stringify(TRIGGER) +
      ') !== null' +
      '  };' +
      '})',
  )
  if (!Array.isArray(value)) return { withTrigger: [], withoutTrigger: [] }
  return {
    withTrigger: value.filter((row) => row.hasTrigger === true).map((row) => row.label),
    withoutTrigger: value.filter((row) => row.hasTrigger !== true).map((row) => row.label),
  }
}

/** The outerHTML of the first trigger, for diagnosing selector drift. */
export async function firstTriggerHtml(session) {
  const value = await session.evaluate(
    'var node = document.querySelector(' + JSON.stringify(TRIGGER) + '); node === null ? "NONE" : node.outerHTML.slice(0, 300)',
  )
  return typeof value === 'string' ? value : String(value)
}

/** Current affiliate roots listed by an open panel, if any. */
export async function panelRoots(session) {
  const value = await session.evaluate(
    '[' +
      '...document.querySelectorAll(' +
      JSON.stringify(PANEL + ' li span') +
      ')' +
      '].map(function (node) { return node.textContent.trim() })',
  )
  return Array.isArray(value) ? value : []
}

/** Sniff the plugin's fetch traffic seen through CDP Network events. */
export function subWorkspaceRequests(session, needle = 'sub-workspace') {
  return session.networkUrls.filter((url) => String(url).includes(needle))
}
