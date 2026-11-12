/**
 * The affiliate-path store: `workspaceKey -> [absolute physical directory]`.
 *
 * Persisted as one JSON document under `$DSH_HOME/sub-workspace/affiliates.json`.
 * The store is the ONLY mutable state the plugin owns; the decoration reads it
 * on every `resolve()` call, so a change is visible to the very next tool call
 * — new sessions and already-running historical sessions alike.
 *
 * Key design point: a workspace is identified by its **immutable cwd path**
 * (`session.header.cwd`), not by the workspaceId. Workspaces can be renamed or
 * even re-registered while their directory stays the same, and a policy is
 * resolved per Session, whose only stable identity is that cwd.
 *
 * @module dsh-sub-workspace/store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** Resolve `$DSH_HOME` the same way every other DSH component does. */
export function dshHome() {
  const env = process.env.DSH_HOME?.trim()
  return env !== undefined && env !== '' ? env : join(homedir(), '.dsh')
}

/** Absolute path of the persisted affiliate document. */
export function storeFile() {
  return join(dshHome(), 'sub-workspace', 'affiliates.json')
}

/**
 * Durable affiliate store with an in-memory mirror.
 *
 * Writes are atomic (temp file + rename) so a crash mid-write can never leave a
 * truncated document that would silently drop every grant on the next boot.
 */
export class AffiliateStore {
  /** @param {string} [file] - override for tests. */
  constructor(file = storeFile()) {
    this.file = file
    /** @type {Map<string, string[]>} */
    this.byKey = new Map()
    this.lastError = undefined
    /** Identity of the document the in-memory mirror was built from. */
    this.loadedMtimeMs = undefined
    this.loadedSize = undefined
    /** Monotonic guard so the hot path cannot stat more than once per interval. */
    this.lastCheckAt = 0
    this.checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS
    this.load()
  }

  /**
   * Read the document, tolerating absence; a corrupt document is isolated.
   *
   * Parsing happens into a scratch map and is only committed on success, so a
   * half-written or corrupt file can never silently drop every grant.
   */
  load() {
    let text
    let stat
    try {
      stat = statSync(this.file)
      text = readFileSync(this.file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        // A removed document means "no grants"; record the absence so a later
        // re-creation is detected as a change.
        this.byKey.clear()
        this.loadedMtimeMs = undefined
        this.loadedSize = undefined
        return
      }
      this.lastError = `cannot read ${this.file}: ${error?.message ?? error}`
      return
    }
    let doc
    try {
      doc = JSON.parse(text)
    } catch (error) {
      this.lastError = `ignoring corrupt ${this.file}: ${error?.message ?? error}`
      // Keep serving the last good mirror rather than losing every grant.
      this.loadedMtimeMs = stat.mtimeMs
      this.loadedSize = stat.size
      return
    }
    const next = new Map()
    const ws = doc?.workspaces
    if (ws !== undefined && typeof ws === 'object' && ws !== null) {
      for (const [key, roots] of Object.entries(ws)) {
        if (!Array.isArray(roots)) continue
        const clean = roots.filter((r) => typeof r === 'string' && r.length > 0)
        if (clean.length > 0) next.set(key, clean)
      }
    }
    this.byKey = next
    this.loadedMtimeMs = stat.mtimeMs
    this.loadedSize = stat.size
  }

  /**
   * Cheap freshness check for the hot path.
   *
   * The decoration's `resolve()` runs on every capability call, so this must
   * stay allocation-free for the common case. It therefore (a) does nothing
   * until `checkIntervalMs` has elapsed and (b) then only performs a single
   * `statSync`, re-reading the document only when the file identity changed.
   *
   * Why this exists: the documented way to configure affiliates is to edit
   * `affiliates.json` by hand, and a second `AffiliateStore` (or a stale one
   * captured by an older activation) would otherwise keep serving a mirror that
   * no longer matches the disk — the exact "store has roots but the sandbox
   * never sees them" symptom.
   */
  refresh() {
    const now = Date.now()
    if (now - this.lastCheckAt < this.checkIntervalMs) return
    this.lastCheckAt = now
    let stat
    try {
      stat = statSync(this.file)
    } catch (error) {
      // Missing now: if we previously had a document, treat it as cleared.
      if (error?.code === 'ENOENT' && (this.loadedMtimeMs !== undefined || this.byKey.size > 0)) {
        this.load()
      }
      return
    }
    if (stat.mtimeMs === this.loadedMtimeMs && stat.size === this.loadedSize) return
    this.load()
  }

  /** Persist the in-memory mirror atomically. */
  save() {
    const doc = { version: 1, workspaces: Object.fromEntries(this.byKey) }
    const text = JSON.stringify(doc, null, 2) + '\n'
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, this.file)
    // Record the identity we just produced so refresh() does not treat our own
    // write as an external change and re-read it back.
    try {
      const stat = statSync(this.file)
      this.loadedMtimeMs = stat.mtimeMs
      this.loadedSize = stat.size
    } catch {
      this.loadedMtimeMs = undefined
      this.loadedSize = undefined
    }
  }

  /**
   * Affiliate roots for one resolved policy request.
   *
   * `request.session` is the official shape; a request without a session (an
   * agentless call) gets no affiliates, because affiliates are a per-workspace
   * concept and there is no workspace without a Session.
   *
   * @param {{session?: {header?: {cwd?: string}}}} request
   * @returns {string[]} physical roots, possibly empty.
   */
  rootsFor(request) {
    // Cheap, rate-limited disk freshness check BEFORE reading the mirror, so a
    // hand-edited document (or another instance's write) is picked up without
    // paying a stat on every single capability call.
    this.refresh()
    const cwd = request?.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') return EMPTY
    const roots = this.byKey.get(cwd)
    return roots === undefined || roots.length === 0 ? EMPTY : roots
  }

  /** Every registered workspace key. */
  keys() {
    this.refresh()
    return [...this.byKey.keys()]
  }

  /** Roots currently stored for one workspace key. */
  get(key) {
    this.refresh()
    const roots = this.byKey.get(key)
    return roots === undefined ? [] : [...roots]
  }

  /** Replace one workspace's roots (empty array removes the entry). */
  set(key, roots) {
    if (roots.length === 0) this.byKey.delete(key)
    else this.byKey.set(key, [...roots])
    this.save()
  }

  /** Add one root; a duplicate is a no-op. */
  add(key, root) {
    const current = this.get(key)
    if (current.includes(root)) return current
    const next = [...current, root]
    this.set(key, next)
    return next
  }

  /** Remove one root; an absent root is a no-op. */
  remove(key, root) {
    const current = this.get(key)
    const next = current.filter((r) => r !== root)
    if (next.length !== current.length) this.set(key, next)
    return next
  }
}

/**
 * Minimum spacing between two hot-path freshness checks, in milliseconds.
 *
 * `resolve()` runs per capability call and per prompt render, so an unthrottled
 * `stat` would add a syscall to every model step. 1000 ms still makes a
 * hand-edit of `affiliates.json` effective "essentially immediately" from a
 * user's point of view while keeping the hot path free in steady state.
 */
export const DEFAULT_CHECK_INTERVAL_MS = 1000

/** Shared immutable empty result so the hot path allocates nothing. */
export const EMPTY = Object.freeze([])

/** Whether a file already exists at the store path (diagnostics only). */
export function storeExists(file = storeFile()) {
  return existsSync(file)
}
