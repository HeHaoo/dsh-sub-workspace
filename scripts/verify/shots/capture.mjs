#!/usr/bin/env node
/**
 * Panel appearance check: inject the LOCAL lib/client.js into the live DSH page,
 * open the affiliate panel, measure what the browser actually painted, and save
 * one screenshot per theme.
 *
 * Why injection and not just reloading the page: the DSH instance that is running
 * loads this plugin from its own profile directory, so the browser serves the
 * OLD client.js. Only injecting the local source exercises the edits.
 *
 * Checks
 *   - the panel background is not white (the white-on-white bug)
 *   - text vs the PAINTED surface contrast >= 4.5:1, computed from a pixel of the
 *     real screenshot (the surface is translucent, so the CSS declaration alone
 *     does not tell you what the user sees)
 *   - border-radius is 16px (--dsw-radius-lg, the host popover radius)
 *   - backdrop-filter is set (host menu material)
 *   - the same numbers hold in BOTH themes
 *
 * Usage: node scripts/verify/shots/capture.mjs [--port 52524] [--cdp-port 9334]
 * Exit codes: 0 pass, 1 fail, 2 precondition missing.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

import { readAuthSecret, dshPort, cdpPort, parseArgs, reporter, run, clip, PLUGIN_ROOT } from '../lib/env.mjs'
import { openAuthenticatedPage } from '../lib/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = parseArgs()
const port = dshPort(args.get('port'))
const debugPort = cdpPort(args.get('cdp-port'))
const source = readFileSync(join(PLUGIN_ROOT, 'lib', 'client.js'), 'utf8')
mkdirSync(HERE, { recursive: true })

const VIEWPORT = { width: 1280, height: 800 }
const DPR = 2

/** Installed-plugin nodes are dropped first so the local source owns the DOM. */
const INJECT = (sourceText) =>
  '(async function () {' +
  '  var TRIGGER = "[data-subworkspace-trigger]";' +
  '  var STYLE = "style[data-plugin=\\\"dsh-sub-workspace\\\"]";' +
  // Repeated runs share one long-lived tab. Tear the previous run's instance down
  // first: its teardown drops the observers and the retry poll, so instances do
  // not pile up (which would both duplicate triggers and slow the tab down).
  '  if (Array.isArray(window.__swsEffects)) {' +
  '    window.__swsEffects.forEach(function (dispose) {' +
  '      try { if (typeof dispose === "function") dispose() } catch (error) {}' +
  '    });' +
  '  }' +
  '  window.__swsEffects = null;' +
  '  document.querySelectorAll(TRIGGER).forEach(function (n) { n.remove() });' +
  '  document.querySelectorAll(STYLE).forEach(function (n) { n.remove() });' +
  '  var rows = document.querySelectorAll(".bw-row[role=\\\"treeitem\\\"]").length;' +
  '  var previousLoader = window.__ModuleLoader__;' +
  '  window.__ModuleLoader__ = { load: function (def) { window.__swsDef = def } };' +
  '  try { (new Function("window", ' + JSON.stringify(sourceText) + '))(window) }' +
  '  finally {' +
  '    if (previousLoader === undefined) delete window.__ModuleLoader__;' +
  '    else window.__ModuleLoader__ = previousLoader;' +
  '  }' +
  '  var def = window.__swsDef; delete window.__swsDef;' +
  '  if (!def || typeof def.factory !== "function") return { stage: "no-def", rows: rows };' +
  '  var mod = def.factory(function () { return {} });' +
  '  if (!mod || typeof mod.apply !== "function") return { stage: "no-apply", rows: rows };' +
  '  window.__swsEffects = [];' +
  '  mod.apply({ effect: function (cb) { var d = cb(); window.__swsEffects.push(d); return d } });' +
  '  var deadline = Date.now() + 12000;' +
  '  while (Date.now() < deadline && document.querySelectorAll(TRIGGER).length === 0) {' +
  '    await new Promise(function (r) { setTimeout(r, 150) })' +
  '  }' +
  '  return { stage: "done", rows: rows, triggers: document.querySelectorAll(TRIGGER).length,' +
  '           styles: document.querySelectorAll(STYLE).length };' +
  '})()'

/**
 * Open a panel that actually lists an affiliate path.
 *
 * A workspace with no affiliate paths renders the empty state, which is a
 * different (and much less interesting) layout — the check wants a populated
 * row so it can measure the path line and the 移除 button.
 */
const OPEN_PANEL = '(async function () {' +
  '  var triggers = [].slice.call(document.querySelectorAll("[data-subworkspace-trigger]"));' +
  '  if (triggers.length === 0) return { stage: "no-trigger" };' +
  '  var waitFor = async function (predicate, ms) {' +
  '    var deadline = Date.now() + ms;' +
  '    while (Date.now() < deadline) {' +
  '      if (predicate()) return true;' +
  '      await new Promise(function (r) { setTimeout(r, 60) })' +
  '    }' +
  '    return predicate();' +
  '  };' +
  '  var found = null;' +
  '  var tried = 0;' +
  '  var budget = Date.now() + 12000;' +
  '  for (var i = 0; i < triggers.length && found === null && Date.now() < budget; i += 1) {' +
  '    triggers[i].click();' +
  '    tried += 1;' +
  '    await waitFor(function () { return document.querySelector(".sws-panel") !== null }, 1200);' +
  '    var panel = document.querySelector(".sws-panel");' +
  '    if (panel === null) continue;' +
  '    await waitFor(function () { return panel.querySelector("li span") !== null }, 900);' +
  '    if (panel.querySelector("li span") !== null) { found = panel; break }' +
  '    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));' +
  '    panel.remove();' +
  '  }' +
  '  if (found === null) return { stage: "no-populated-panel", tried: tried };' +
  '  var rect = found.getBoundingClientRect();' +
  '  return { stage: "open", attempts: tried, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };' +
  '})()'

/** Everything the checks judge, read off the live layout tree. */
const MEASURE = '(function () {' +
  '  var panel = document.querySelector(".sws-panel");' +
  '  if (panel === null) return { stage: "missing" };' +
  '  var cs = getComputedStyle(panel);' +
  '  var h4 = getComputedStyle(panel.querySelector("h4"));' +
  '  var li = panel.querySelector("li");' +
  '  var liCs = li === null ? null : getComputedStyle(li);' +
  '  var liSpan = li === null ? null : li.querySelector("span");' +
  '  var input = panel.querySelector("input[type=text]");' +
  '  var inputCs = input === null ? null : getComputedStyle(input);' +
  '  var primary = panel.querySelector("button.primary");' +
  '  var primaryCs = primary === null ? null : getComputedStyle(primary);' +
  '  var danger = panel.querySelector("button.danger");' +
  '  var dangerCs = danger === null ? null : getComputedStyle(danger);' +
  '  var closeBtn = panel.querySelector("h4 button");' +
  '  var closeCs = closeBtn === null ? null : getComputedStyle(closeBtn);' +
  '  var trigger = document.querySelector("[data-subworkspace-trigger]");' +
  '  var triggerCs = trigger === null ? null : getComputedStyle(trigger);' +
  '  var rect = panel.getBoundingClientRect();' +
  '  return {' +
  '    stage: "done",' +
  '    dark: document.body.hasAttribute("data-ds-dark-theme"),' +
  '    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },' +
  '    panel: { bg: cs.backgroundColor, color: cs.color, radius: cs.borderTopLeftRadius,' +
  '             border: cs.borderTopWidth + " " + cs.borderTopStyle + " " + cs.borderTopColor,' +
  '             backdrop: cs.backdropFilter || cs.webkitBackdropFilter,' +
  '             boxShadow: cs.boxShadow, fontFamily: cs.fontFamily.slice(0, 40),' +
  '             fontSize: cs.fontSize, padding: cs.padding },' +
  '    heading: { color: h4.color, fontSize: h4.fontSize, fontWeight: h4.fontWeight },' +
  '    row: liCs === null ? null : { bg: liCs.backgroundColor, color: liCs.color,' +
  '             radius: liCs.borderRadius, border: liCs.border, fontSize: liCs.fontSize,' +
  '             text: liSpan === null ? "" : liSpan.textContent },' +
  '    input: inputCs === null ? null : { bg: inputCs.backgroundColor, color: inputCs.color,' +
  '             radius: inputCs.borderRadius, placeholder: input.placeholder },' +
  '    primary: primaryCs === null ? null : { bg: primaryCs.backgroundColor, color: primaryCs.color,' +
  '             radius: primaryCs.borderRadius, height: primaryCs.height },' +
  '    danger: dangerCs === null ? null : { bg: dangerCs.backgroundColor, color: dangerCs.color,' +
  '             radius: dangerCs.borderRadius, height: dangerCs.height },' +
  '    closeBtn: closeCs === null ? null : { bg: closeCs.backgroundColor, color: closeCs.color,' +
  '             radius: closeCs.borderRadius, height: closeCs.height },' +
  '    trigger: triggerCs === null ? null : { bg: triggerCs.backgroundColor, color: triggerCs.color,' +
  '             radius: triggerCs.borderRadius, height: triggerCs.height, fontSize: triggerCs.fontSize }' +
  '  };' +
  '})()'

/** A point inside the panel's top padding: surface only, no text, no round corner. */
const SURFACE_POINT = '(function () {' +
  '  var r = document.querySelector(".sws-panel").getBoundingClientRect();' +
  '  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 5) };' +
  '})()'

const SET_THEME = (mode) =>
  mode === 'light'
    ? "(function () { document.body.removeAttribute('data-ds-dark-theme');" +
      " document.documentElement.setAttribute('data-ds-theme-source', 'light');" +
      " document.documentElement.style.colorScheme = 'light';" +
      " return getComputedStyle(document.body).getPropertyValue('--dsw-alias-label-primary').trim() })()"
    : "(function () { document.body.setAttribute('data-ds-dark-theme', '');" +
      " document.documentElement.setAttribute('data-ds-theme-source', 'dark');" +
      " document.documentElement.style.colorScheme = 'dark';" +
      " return getComputedStyle(document.body).getPropertyValue('--dsw-alias-label-primary').trim() })()"

// ------------------------------------------------------------------ colour ---

/**
 * Parse a computed `rgb()` / `rgba()` string.
 *
 * Deliberately regex-free: this file is generated through several string layers,
 * and backslash escaping in a regex literal is exactly the kind of thing that
 * silently turns `\\(` into `(` and makes every number NaN.
 */
function parseColour(text) {
  const source = String(text).trim()
  const open = source.indexOf('(')
  const close = source.indexOf(')', open + 1)
  if (open === -1 || close === -1) return null
  const parts = source
    .slice(open + 1, close)
    .split(/[ ,/]+/)
    .filter((part) => part !== '')
    .map(Number)
  if (parts.length < 3 || parts.some((value) => !Number.isFinite(value))) return null
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
}

function channelLuminance(value) {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function relativeLuminance(rgb) {
  return 0.2126 * channelLuminance(rgb.r) + 0.7152 * channelLuminance(rgb.g) + 0.0722 * channelLuminance(rgb.b)
}

/** WCAG 2.x contrast ratio between two opaque colours. */
function contrastRatio(a, b) {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

// --------------------------------------------------------------- png pixel ---

/**
 * Decode one pixel out of a Chrome PNG screenshot.
 *
 * Chrome emits 8-bit RGB or RGBA, non-interlaced; that is all this needs to
 * handle, and it keeps the verification free of image dependencies.
 *
 * @returns {{r: number, g: number, b: number} | null} null when unparseable.
 */
export function pngPixel(buffer, x, y) {
  try {
    if (buffer.readUInt32BE(0) !== 0x89504e47) return null
    let offset = 8
    let header = null
    const idat = []
    while (offset + 8 <= buffer.length) {
      const length = buffer.readUInt32BE(offset)
      const type = buffer.toString('ascii', offset + 4, offset + 8)
      const data = buffer.subarray(offset + 8, offset + 8 + length)
      if (type === 'IHDR') {
        header = {
          width: data.readUInt32BE(0),
          height: data.readUInt32BE(4),
          bitDepth: data[8],
          colourType: data[9],
          interlace: data[12],
        }
      } else if (type === 'IDAT') {
        idat.push(data)
      } else if (type === 'IEND') {
        break
      }
      offset += 12 + length
    }
    if (header === null) return null
    if (header.bitDepth !== 8 || header.interlace !== 0) return null
    const channels = header.colourType === 6 ? 4 : header.colourType === 2 ? 3 : 0
    if (channels === 0) return null
    if (x < 0 || y < 0 || x >= header.width || y >= header.height) return null

    const raw = inflateSync(Buffer.concat(idat))
    const stride = header.width * channels
    let previous = Buffer.alloc(stride)
    for (let row = 0; row <= y; row += 1) {
      const start = row * (stride + 1)
      const filter = raw[start]
      const line = Buffer.from(raw.subarray(start + 1, start + 1 + stride))
      for (let i = 0; i < stride; i += 1) {
        const left = i >= channels ? line[i - channels] : 0
        const up = previous[i]
        const upLeft = i >= channels ? previous[i - channels] : 0
        if (filter === 1) line[i] = (line[i] + left) & 0xff
        else if (filter === 2) line[i] = (line[i] + up) & 0xff
        else if (filter === 3) line[i] = (line[i] + ((left + up) >> 1)) & 0xff
        else if (filter === 4) {
          const p = left + up - upLeft
          const pa = Math.abs(p - left)
          const pb = Math.abs(p - up)
          const pc = Math.abs(p - upLeft)
          const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
          line[i] = (line[i] + predictor) & 0xff
        }
      }
      previous = line
    }
    const at = x * channels
    return { r: previous[at], g: previous[at + 1], b: previous[at + 2] }
  } catch {
    return null
  }
}

// -------------------------------------------------------------------- main ---

await run(async () => {
  const report = reporter('panel appearance — injected source, live page, both themes')
  const { secret } = readAuthSecret()
  const { session, mark } = await openAuthenticatedPage({ port, cdpPort: debugPort, secret })

  try {
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: DPR,
      mobile: false,
    })

    const injected = await session.evaluate(INJECT(source))
    if (injected !== null && injected.stage === 'done' && injected.triggers > 0) {
      report.pass('local source injects and decorates rows',
        injected.triggers + '/' + injected.rows + ' row(s), ' + injected.styles + ' stylesheet')
    } else {
      report.fail('local source injects and decorates rows', clip(JSON.stringify(injected), 240))
      report.print()
      return 1
    }

    const opened = await session.evaluate(OPEN_PANEL)
    if (opened === null || opened.stage !== 'open') {
      report.fail('the panel opens with the injected source', clip(JSON.stringify(opened), 200))
      report.print()
      return 1
    }
    report.pass('the panel opens with the injected source',
      Math.round(opened.rect.width) + 'x' + Math.round(opened.rect.height) +
      ' at ' + Math.round(opened.rect.x) + ',' + Math.round(opened.rect.y))

    const shots = []
    for (const mode of ['dark', 'light']) {
      const labelValue = await session.evaluate(SET_THEME(mode))
      await new Promise((resolve) => setTimeout(resolve, 350))
      const m = await session.evaluate(MEASURE)
      if (m === null || m.stage !== 'done') {
        report.fail(mode + ': panel measurable', clip(JSON.stringify(m), 200))
        continue
      }
      report.info(mode + ': theme state', 'data-ds-dark-theme=' + m.dark + ', --dsw-alias-label-primary=' + labelValue)

      // ---- screenshot ------------------------------------------------
      const pad = 28
      const x = Math.max(0, m.rect.x - pad)
      const y = Math.max(0, m.rect.y - pad)
      const capture = {
        x,
        y,
        width: Math.min(VIEWPORT.width - x, m.rect.width + pad * 2),
        height: Math.min(VIEWPORT.height - y, m.rect.height + pad * 2),
        scale: 1,
      }
      const shot = await session.send('Page.captureScreenshot', { format: 'png', clip: capture, captureBeyondViewport: false })
      const png = Buffer.from(shot.data, 'base64')
      const file = join(HERE, 'panel-' + mode + '.png')
      writeFileSync(file, png)
      shots.push(file)
      report.pass(mode + ': screenshot saved', file + ' (' + Math.round(png.length / 1024) + ' KB)')

      // ---- background must not be white (the original bug) -----------
      const bg = parseColour(m.panel.bg)
      if (bg === null) {
        report.fail(mode + ': panel background parsed', m.panel.bg)
      } else {
        const isWhite = bg.r > 250 && bg.g > 250 && bg.b > 250 && bg.a > 0.9
        if (isWhite) report.fail(mode + ': panel background is not white', m.panel.bg)
        else report.pass(mode + ': panel background is not white', m.panel.bg)
        if (bg.a < 1) report.pass(mode + ': surface is translucent like the host menu', 'alpha=' + bg.a)
        else report.fail(mode + ': surface is translucent like the host menu', 'opaque ' + m.panel.bg)
      }

      // ---- contrast, against the real composited pixel -------------
      const point = await session.evaluate(SURFACE_POINT)
      const painted = pngPixel(png, Math.round((point.x - capture.x) * DPR), Math.round((point.y - capture.y) * DPR))
      const text = parseColour(m.heading.color)
      if (painted === null) {
        report.fail(mode + ': painted surface pixel sampled', 'could not decode the screenshot PNG')
      } else {
        report.info(mode + ': painted surface pixel below the heading',
          'rgb(' + painted.r + ',' + painted.g + ',' + painted.b + ')')
        if (text === null) {
          report.fail(mode + ': heading colour parsed', m.heading.color)
        } else {
          const ratio = contrastRatio(text, painted)
          const detail = ratio.toFixed(2) + ':1 (' + m.heading.color + ' on rgb(' +
            painted.r + ',' + painted.g + ',' + painted.b + '), from the screenshot)'
          if (ratio >= 4.5) report.pass(mode + ': panel text/background contrast >= 4.5:1', detail)
          else report.fail(mode + ': panel text/background contrast >= 4.5:1', detail)
        }
      }

      // ---- host popover recipe --------------------------------------
      if (m.panel.radius === '16px') report.pass(mode + ': corner radius is 16px', m.panel.radius)
      else report.fail(mode + ': corner radius is 16px', m.panel.radius)
      if (String(m.panel.backdrop).includes('blur')) report.pass(mode + ': backdrop-filter is a blur', m.panel.backdrop)
      else report.fail(mode + ': backdrop-filter is a blur', String(m.panel.backdrop))
      if (String(m.panel.boxShadow) !== 'none') report.pass(mode + ': elevation shadow present', clip(m.panel.boxShadow, 90))
      else report.fail(mode + ': elevation shadow present', 'none')
      report.info(mode + ': panel font', m.panel.fontFamily + ' @ ' + m.panel.fontSize + ' / padding ' + m.panel.padding)
      report.info(mode + ': panel border', m.panel.border)

      // ---- the affiliate row must read as a distinct layer ----------
      if (m.row !== null) {
        const rowBg = parseColour(m.row.bg)
        const rowText = parseColour(m.row.color)
        if (rowBg !== null && rowText !== null && rowBg.a >= 0.9) {
          const ratio = contrastRatio(rowText, rowBg)
          const detail = ratio.toFixed(2) + ':1 (' + m.row.color + ' on ' + m.row.bg + ')'
          if (ratio >= 4.5) report.pass(mode + ': affiliate row contrast >= 4.5:1', detail)
          else report.fail(mode + ': affiliate row contrast >= 4.5:1', detail)
        } else {
          report.info(mode + ': affiliate row layering', m.row.bg + ' + border ' + m.row.border)
        }
        report.info(mode + ': affiliate row', JSON.stringify(m.row.text) + ' / radius ' + m.row.radius)
      }

      // ---- trigger restyle -----------------------------------------
      if (m.trigger !== null) {
        if (m.trigger.bg === 'rgba(0, 0, 0, 0)') report.pass(mode + ': 附属 trigger has a transparent fill', m.trigger.bg)
        else report.info(mode + ': 附属 trigger fill', m.trigger.bg)
        if (m.trigger.radius === '8px') report.pass(mode + ': 附属 trigger radius is 8px (host icon button)', m.trigger.radius)
        else report.fail(mode + ': 附属 trigger radius is 8px (host icon button)', m.trigger.radius)
        report.info(mode + ': 附属 trigger',
          'h=' + m.trigger.height + ' font=' + m.trigger.fontSize + ' color=' + m.trigger.color)
      }
      if (m.input !== null) report.info(mode + ': path input', m.input.bg + ' / ' + m.input.radius + ' / placeholder=' + JSON.stringify(m.input.placeholder))
      if (m.primary !== null) {
        const pb = parseColour(m.primary.bg)
        const pt = parseColour(m.primary.color)
        if (pb !== null && pt !== null) {
          const ratio = contrastRatio(pt, pb)
          const detail = ratio.toFixed(2) + ':1 (' + m.primary.color + ' on ' + m.primary.bg + ')'
          if (ratio >= 4.5) report.pass(mode + ': primary button contrast >= 4.5:1', detail)
          else report.fail(mode + ': primary button contrast >= 4.5:1', detail)
        }
        report.info(mode + ': primary button', m.primary.bg + ' / h=' + m.primary.height + ' radius ' + m.primary.radius)
      }
      if (m.danger !== null) report.info(mode + ': remove button', m.danger.color + ' on ' + m.danger.bg + ' h=' + m.danger.height)
      if (m.closeBtn !== null) report.info(mode + ': close button', m.closeBtn.color + ' on ' + m.closeBtn.bg + ' h=' + m.closeBtn.height)
    }

    const exceptions = session.exceptionsSince(mark)
    if (exceptions.length === 0) report.pass('no page exceptions during the check')
    else report.fail('no page exceptions during the check', clip(exceptions[0].text, 240))

    console.log('')
    console.log('screenshots:')
    for (const shot of shots) console.log('  ' + shot)

    const summary = report.print()
    return summary.failed === 0 ? 0 : 1
  } finally {
    await session.evaluate(SET_THEME('dark')).catch(() => {})
    session.close()
  }
})
