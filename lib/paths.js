/**
 * Path helpers for affiliate (extra writable) roots.
 *
 * These mirror the official `dsh-sandbox` conventions so a decorated policy is
 * indistinguishable from one the deployment configured through
 * `additionalWritableRoots`:
 *
 *  - entries are stored in their physical (realpath) spelling, because both the
 *    Seatbelt filter and the fs fence compare resolved paths
 *    (`/tmp` IS `/private/tmp` on darwin);
 *  - a symlinked grant is refused outright, so a swap cannot redirect a grant;
 *  - a non-existent or non-directory entry is refused.
 *
 * The official `additionalRoot()` throws mid-enforcement when an entry is bad,
 * which would break EVERY write, not just the bad entry. This module validates
 * eagerly instead, so the resolve-time hot path only ever carries clean roots.
 *
 * `~` support: a leading `~` is expanded to the home directory before anything
 * else, so `~/foo` behaves exactly like the absolute path it spells. Only the
 * bare `~` and `~/...` forms are expanded — `~someuser` is refused, because a
 * reliable account lookup is unavailable here and guessing an account name
 * would grant a directory the user never named. A `~` anywhere else in the path
 * is an ordinary character and is never expanded.
 *
 * @module dsh-sub-workspace/paths
 */

import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve as resolvePath, sep } from 'node:path'

/** Collapse separators and drop a trailing separator; keep root spellings intact. */
export function canonicalPath(path) {
  const trimmed = String(path ?? '').trim()
  if (trimmed === '') return ''
  const collapsed = trimmed.replace(/[\\/]{2,}/g, sep === '\\' ? '\\' : '/')
  const stripped = collapsed.replace(/[\\/]+$/, '')
  if (stripped === '') return collapsed
  return stripped.endsWith(':') ? stripped + sep : stripped
}

/**
 * Expand a leading `~` to the home directory.
 *
 * Expansion is deliberately narrow:
 *   `~`             → homedir()
 *   `~/rest`        → join(homedir(), 'rest')   (`~//rest`, `~/./rest` describe
 *                                               the same directory and land on
 *                                               the same normalized result)
 *   `~\\rest`       → same, so a Windows-style separator is accepted too
 *   `~someuser/...` → throws: shell-style `~user` expansion is not supported
 *   `/a/~/b`        → unchanged; that `~` is an ordinary path character
 *
 * Only the first character is examined, so a `~` inside the path never becomes
 * a home reference.
 *
 * @param path - user-supplied path, absolute or home-relative.
 * @returns the input with a leading `~` expanded; otherwise unchanged.
 * @throws Error when a shell-style `~user` prefix is used.
 */
export function expandHome(path) {
  const raw = String(path ?? '').trim()
  if (!raw.startsWith('~')) return raw
  const tail = raw.slice(1)
  // `~` alone, or a separator right after the tilde, is a home reference.
  if (tail === '' || tail.startsWith('/') || tail.startsWith('\\')) {
    const rest = tail.replace(/^[\\/]+/, '')
    const home = homedir()
    // join() normalizes `//`, `./` and `../` inside `rest` for us; it keeps a
    // trailing separator, which names the same directory, so strip it too.
    const joined = rest === '' ? home : join(home, rest)
    return joined.length > 1 ? joined.replace(/[\\/]+$/, '') : joined
  }
  // `~someuser`, `~someuser/`, `~someuser/x`: refuse rather than guess an account.
  throw new Error(
    `affiliate root: ~user expansion is not supported, use an absolute path or ~/...: ${JSON.stringify(raw)}`,
  )
}

/** Describe the path being validated, keeping the user's spelling visible. */
function describe(raw, expanded) {
  return raw === expanded ? `${expanded}` : `${expanded} (from ${JSON.stringify(raw)})`
}

/**
 * Validate one proposed affiliate root.
 *
 * Order matters, and it is the whole point of this function: expand `~` first,
 * then require the RESULT to be absolute, then realpath + stat it, then refuse a
 * symlink. Checking the raw input instead would let `~/x` slip through the
 * absolute test (it resolves under the cwd, so it "looks" absolute) and only
 * fail later as a baffling "not readable" error.
 *
 * @param path - user-supplied absolute directory, or a `~/...` one.
 * @returns the physical directory spelling.
 * @throws Error naming the reason when the entry cannot be granted safely.
 */
export function validateRoot(path) {
  const raw = String(path ?? '').trim()
  if (raw === '') throw new Error('affiliate root must not be blank')
  const expanded = expandHome(raw)
  if (expanded === '') throw new Error('affiliate root must not be blank')
  if (!isAbsolute(expanded) && !/^[A-Za-z]:[\\/]/.test(expanded)) {
    throw new Error(`affiliate root must be absolute: ${JSON.stringify(raw)}`)
  }
  let physical
  let isDir = false
  try {
    physical = realpathSync.native(expanded)
    isDir = statSync(physical).isDirectory()
  } catch (error) {
    throw new Error(`affiliate root is not readable: ${describe(raw, expanded)} (${error?.message ?? error})`)
  }
  if (!isDir) throw new Error(`affiliate root must be a directory: ${describe(raw, expanded)}`)
  // Compared against the EXPANDED path: `~/Git/x` and `/Users/me/Git/x` must be
  // judged identically, and a symlink is still refused either way.
  //
  // The comparison is case-INSENSITIVE on Windows. `fs.realpathSync.native()`
  // returns the canonical on-disk casing there, while `resolve()` keeps whatever
  // the user typed, so a strict `===` would reject a perfectly ordinary
  // directory (`c:\\Users\\me\\repo` vs `C:\\Users\\me\\repo`) as though it were a
  // symlink. Windows paths are case-insensitive, so folding is the correct test,
  // not a loophole: a real symlink still resolves to a DIFFERENT path, not just
  // a differently-cased one.
  const physicalComparable = process.platform === 'win32' ? physical.toLowerCase() : physical
  const expandedComparable = process.platform === 'win32' ? resolvePath(expanded).toLowerCase() : resolvePath(expanded)
  if (physicalComparable !== expandedComparable) {
    throw new Error(
      `affiliate root must be the physical path, not a symlink: ${describe(raw, expanded)} -> use ${JSON.stringify(physical)}`,
    )
  }
  return physical
}

/**
 * Every spelling a stored affiliate root may have, for exact-match comparison.
 *
 * Roots are persisted physically, so `remove('~/x')` would miss a root stored as
 * `/Users/me/x` unless it is resolved to that same spelling first. Unresolvable
 * spellings are still returned: a removal that cannot match is a no-op, never an
 * error.
 *
 * @param path - user-supplied path, absolute or `~/...`.
 * @returns unique candidate spellings, the physical one first when it resolves.
 */
export function removalCandidates(path) {
  const raw = String(path ?? '').trim()
  if (raw === '') return []
  let expanded
  try {
    expanded = expandHome(raw)
  } catch {
    // `~user` cannot be expanded, so the raw spelling is the only candidate.
    return [raw]
  }
  const out = []
  try {
    out.push(realpathSync.native(expanded))
  } catch {
    /* not resolvable: fall through to the textual spellings */
  }
  for (const candidate of [expanded, canonicalPath(expanded), resolvePath(expanded)]) {
    if (candidate !== '' && !out.includes(candidate)) out.push(candidate)
  }
  return out
}

/** Whether `target` is `root` itself or lives underneath it. */
export function isUnder(target, root) {
  const t = canonicalPath(target)
  const r = canonicalPath(root)
  if (t === '' || r === '') return false
  if (t === r) return true
  const base = r.endsWith('/') || r.endsWith('\\') ? r : r + sep
  return t.startsWith(base)
}
