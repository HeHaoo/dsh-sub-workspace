/**
 * Behavioural tests for dsh-sub-workspace.
 *
 * Run with: node --test test/
 *
 * These tests exercise the three requirements directly:
 *   1. the official policy object is preserved, only extra roots are added;
 *   2. affiliates are per workspace (keyed by cwd) and survive rename;
 *   3. the change is visible to the very next resolve() call — the mechanism
 *      behind "immediate effect for new and historical sessions".
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { AffiliateStore } from '../lib/store.js'
import { decorateSandboxPolicy } from '../lib/decorate.js'
import { canonicalPath, expandHome, isUnder, removalCandidates, validateRoot } from '../lib/paths.js'

/** An isolated physical temp dir (darwin /var -> /private/var needs realpath). */
function tempDir() {
  return realpathSync.native(mkdtempSync(join(tmpdir(), 'subws-')))
}

/** A store whose file lives in its own temp dir. */
function tempStore() {
  const dir = tempDir()
  return { store: new AffiliateStore(join(dir, 'affiliates.json')), dir }
}

/**
 * Run `fn` with the home directory pointed at a throwaway physical temp dir.
 *
 * `expandHome` resolves `~` through `os.homedir()`, which reads `$HOME` on
 * POSIX, so overriding the env var is how a test can assert on `~/...`
 * without depending on whatever happens to exist in the developer's home.
 * The temp dir is realpath'd before it becomes `$HOME`, because on darwin
 * `/var` is a symlink to `/private/var` and a non-physical `$HOME` would make
 * every expanded path look like a symlink to `validateRoot`.
 */
function withTempHome(fn) {
  const home = tempDir()
  const previous = process.env.HOME
  process.env.HOME = home
  try {
    return fn(home)
  } finally {
    if (previous === undefined) delete process.env.HOME
    else process.env.HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
}

/** A stand-in for the official SandboxPolicyService with a realistic resolve(). */
function fakeService(writableRoot) {
  return {
    defaultMode: 'workspace-write',
    workspaceRoot: writableRoot,
    resolve(request = {}) {
      return {
        mode: 'workspace-write',
        workspaceRoot: request.session?.header?.cwd ?? writableRoot,
        additionalWritableRoots: ['/deployment/root'],
        ...(request.session === undefined ? {} : { sessionId: request.session.id }),
      }
    },
  }
}

const session = (cwd) => ({ id: `s-${cwd}`, header: { cwd } })

test('canonicalPath collapses separators and drops the trailing one', () => {
  assert.equal(canonicalPath('/a/b/'), '/a/b')
  assert.equal(canonicalPath('/a//b//'), '/a/b')
  assert.equal(canonicalPath('/'), '/')
})

test('isUnder matches the root itself and children, but not siblings', () => {
  assert.equal(isUnder('/a/b', '/a/b'), true)
  assert.equal(isUnder('/a/b/c.txt', '/a/b'), true)
  assert.equal(isUnder('/a/bc', '/a/b'), false)
})

test('validateRoot returns the physical path and refuses symlinks', () => {
  const real = tempDir()
  assert.equal(validateRoot(real), real)

  const linkParent = tempDir()
  const link = join(linkParent, 'link')
  symlinkSync(real, link)
  assert.throws(() => validateRoot(link), /physical path, not a symlink/)
})

// Windows reports canonical on-disk casing from realpathSync.native() while the
// caller may have typed different casing for the SAME directory. A strict `===`
// rejected that ordinary directory as if it were a symlink. The guard is that
// the casing fold is win32-only: a symlink must still be refused on every
// platform, and on POSIX casing stays significant.
test('a symlink is refused on every platform regardless of casing rules', () => {
  const target = tempDir()
  const parent = tempDir()
  const link = join(parent, 'link')
  symlinkSync(target, link)

  // The security guarantee is platform-independent: a link must never be granted.
  assert.throws(() => validateRoot(link), /physical path, not a symlink/)

  // On POSIX the guard keeps casing significant, so a case-flipped spelling of a
  // real directory is simply a different (non-existent) path and is refused.
  if (process.platform !== 'win32') {
    const flipped = target.replace(/[a-z]/i, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))
    if (flipped !== target) {
      assert.throws(() => validateRoot(flipped), /not readable|physical path/)
    }
  }
})
test('validateRoot refuses missing paths and plain files', () => {
  const dir = tempDir()
  assert.throws(() => validateRoot(join(dir, 'nope')), /not readable/)

  const file = join(dir, 'f.txt')
  writeFileSync(file, 'x')
  assert.throws(() => validateRoot(file), /must be a directory/)
})

test('store round-trips through disk and isolates by workspace key', () => {
  const { store } = tempStore()
  const a = tempDir()
  const b = tempDir()

  store.add('/ws/one', a)
  store.add('/ws/one', b)
  store.add('/ws/two', a)

  // A fresh instance must read the same document.
  const reloaded = new AffiliateStore(store.file)
  assert.deepEqual(reloaded.get('/ws/one'), [a, b])
  assert.deepEqual(reloaded.get('/ws/two'), [a])

  // Workspace two must NOT see workspace one's extra root.
  assert.deepEqual(reloaded.rootsFor({ session: session('/ws/two') }), [a])
  assert.deepEqual(reloaded.rootsFor({ session: session('/ws/one') }), [a, b])
})

test('store ignores agentless requests and duplicate adds', () => {
  const { store } = tempStore()
  const a = tempDir()
  store.add('/ws/one', a)
  store.add('/ws/one', a)
  assert.equal(store.get('/ws/one').length, 1)
  assert.deepEqual(store.rootsFor({}), [])
})

test('removing the last root deletes the workspace entry', () => {
  const { store } = tempStore()
  const a = tempDir()
  store.add('/ws/one', a)
  store.remove('/ws/one', a)
  assert.deepEqual(store.get('/ws/one'), [])
  assert.deepEqual(store.keys(), [])
})

test('decoration ADDS roots while preserving every official field', () => {
  const { store } = tempStore()
  const root = tempDir()
  const affiliate = tempDir()
  store.add('/ws/one', affiliate)

  const service = fakeService(root)
  const before = service.resolve({ session: session('/ws/one') })
  const undo = decorateSandboxPolicy(service, store)
  const after = service.resolve({ session: session('/ws/one') })

  // Official facts survive untouched.
  assert.equal(after.mode, before.mode)
  assert.equal(after.workspaceRoot, before.workspaceRoot)
  assert.equal(after.sessionId, before.sessionId)
  // Deployment roots are kept, affiliates appended.
  assert.deepEqual(after.additionalWritableRoots, ['/deployment/root', affiliate])

  undo()
  assert.deepEqual(service.resolve({ session: session('/ws/one') }), before)
})

test('decoration is per workspace: another cwd sees only its own roots', () => {
  const { store } = tempStore()
  const root = tempDir()
  const affiliate = tempDir()
  store.add('/ws/one', affiliate)

  const service = fakeService(root)
  decorateSandboxPolicy(service, store)

  const one = service.resolve({ session: session('/ws/one') })
  const two = service.resolve({ session: session('/ws/two') })

  assert.ok(one.additionalWritableRoots.includes(affiliate))
  assert.ok(!two.additionalWritableRoots.includes(affiliate))
})

test('a change is visible to the NEXT call — the immediate-effect guarantee', () => {
  const { store } = tempStore()
  const root = tempDir()
  const affiliate = tempDir()
  const service = fakeService(root)
  decorateSandboxPolicy(service, store)

  const first = service.resolve({ session: session('/ws/one') })
  assert.ok(!first.additionalWritableRoots.includes(affiliate))

  // Mutate the store the way the tool does after this call started.
  store.add('/ws/one', affiliate)

  const second = service.resolve({ session: session('/ws/one') })
  assert.ok(
    second.additionalWritableRoots.includes(affiliate),
    'the very next resolve() must already carry the new affiliate',
  )
})

test('decoration leaves read-only and danger-full-access policies alone', () => {
  const { store } = tempStore()
  const affiliate = tempDir()
  store.add('/ws/one', affiliate)

  for (const mode of ['read-only', 'danger-full-access']) {
    const service = {
      resolve: () => ({ mode, workspaceRoot: '/ws/one', additionalWritableRoots: [] }),
    }
    decorateSandboxPolicy(service, store)
    const policy = service.resolve({ session: session('/ws/one') })
    assert.deepEqual(policy.additionalWritableRoots, [], `${mode} must not gain affiliate roots`)
  }
})

test('decoration refuses to stack, and undo restores the original', () => {
  const { store } = tempStore()
  const service = fakeService('/ws/one')
  const undo = decorateSandboxPolicy(service, store)
  assert.throws(() => decorateSandboxPolicy(service, store), /already decorated/)
  undo()
  // After undo a fresh decoration must be allowed.
  const undo2 = decorateSandboxPolicy(service, store)
  undo2()
})

test('a resolve() that stops returning an object degrades instead of throwing', () => {
  const { store } = tempStore()
  const warnings = []
  const service = { resolve: () => undefined }
  decorateSandboxPolicy(service, store, { warn: (m) => warnings.push(m) })
  assert.equal(service.resolve({}), undefined)
  assert.equal(warnings.length, 1)
})

test('a corrupt store document is ignored rather than fatal', () => {
  const dir = tempDir()
  const file = join(dir, 'affiliates.json')
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, '{ this is not json')
  const store = new AffiliateStore(file)
  assert.match(store.lastError, /corrupt/)
  assert.deepEqual(store.keys(), [])
})

// ---------------------------------------------------------------------------
// Home-relative paths: a leading `~` behaves exactly like the absolute path it
// spells. `~user` is refused instead of guessed, and a `~` that is not in the
// first position is an ordinary character.
// ---------------------------------------------------------------------------

test('expandHome expands a leading ~ to the home directory', () => {
  withTempHome((home) => {
    const physical = realpathSync.native(home)
    assert.equal(expandHome('~'), physical)
    assert.equal(expandHome('~/'), physical)
    assert.equal(expandHome('~/sub'), join(physical, 'sub'))
  })
})

test('expandHome normalizes redundant separators and dot segments after ~', () => {
  withTempHome((home) => {
    const physical = realpathSync.native(home)
    // `~//sub`, `~/./sub` and `~/sub` all name the same directory.
    assert.equal(expandHome('~//sub'), join(physical, 'sub'))
    assert.equal(expandHome('~/./sub'), join(physical, 'sub'))
    assert.equal(expandHome('~///./sub//'), join(physical, 'sub'))
    // A Windows-style separator right after the tilde is accepted too.
    assert.equal(expandHome('~\\sub'), join(physical, 'sub'))
  })
})

test('expandHome refuses ~user instead of guessing an account', () => {
  // `~someuser` is shell syntax for another account's home. There is no reliable
  // account lookup here, and guessing would grant a directory never named.
  for (const bad of ['~someuser', '~someuser/', '~someuser/sub', '~root/x']) {
    assert.throws(
      () => expandHome(bad),
      /~user expansion is not supported, use an absolute path or ~\/\.\.\./,
      `${bad} must be refused, not expanded`,
    )
  }
  // The message must name the input so the user can see what was rejected.
  assert.throws(() => expandHome('~root/x'), /~root\/x/)
})

test('expandHome leaves a ~ that is not the first character alone', () => {
  for (const path of ['/a/~/b', 'a~/b', 'relative/~/path', '/~/x']) {
    assert.equal(expandHome(path), path, `${path} must not be expanded`)
  }
  // Non-~ inputs are untouched, including empty and blank ones.
  assert.equal(expandHome('/abs/path'), '/abs/path')
  assert.equal(expandHome('rel/path'), 'rel/path')
  assert.equal(expandHome(''), '')
})

test('validateRoot accepts ~ and ~/sub, returning the physical spelling', () => {
  withTempHome((home) => {
    const physical = realpathSync.native(home)
    assert.equal(validateRoot('~'), physical)
    assert.equal(validateRoot('~/'), physical)
    const sub = join(physical, 'sub')
    mkdirSync(sub)
    assert.equal(validateRoot('~/sub'), sub)
    // `~/sub` and its absolute spelling must be judged identically.
    assert.equal(validateRoot('~/sub'), validateRoot(sub))
    assert.equal(validateRoot('~//sub'), sub)
    assert.equal(validateRoot('~/./sub'), sub)
  })
})

test('validateRoot still enforces every rule on the EXPANDED path', () => {
  withTempHome((home) => {
    const physical = realpathSync.native(home)

    // Missing directory: the message names both spellings, so the user can see
    // what `~/nope` turned into instead of reading a bare ENOENT.
    assert.throws(() => validateRoot('~/nope'), /not readable/)
    assert.throws(() => validateRoot('~/nope'), /from "~\/nope"/)

    // A plain file is still refused.
    writeFileSync(join(physical, 'f.txt'), 'x')
    assert.throws(() => validateRoot('~/f.txt'), /must be a directory/)

    // `~user` keeps its dedicated error rather than degrading to a path error.
    assert.throws(() => validateRoot('~someuser/x'), /~user expansion is not supported/)

    // A `~` in the middle is not expanded, so a relative path stays relative.
    assert.throws(() => validateRoot('a~/b'), /must be absolute/)
  })
})

test('validateRoot still refuses a symlink reached through ~', () => {
  // Expanding `~/link` to `<home>/link` and then following it would let a grant
  // be redirected later, so the symlink ban must survive home expansion.
  withTempHome((home) => {
    const physical = realpathSync.native(home)
    const target = tempDir()
    symlinkSync(target, join(physical, 'link'))

    assert.throws(() => validateRoot('~/link'), /physical path, not a symlink/)
    // The refusal must point at the physical directory to use instead.
    assert.throws(() => validateRoot('~/link'), new RegExp(`use "${target}"`))
    // The absolute spelling is refused the same way: one rule, two spellings.
    assert.throws(() => validateRoot(join(physical, 'link')), /physical path, not a symlink/)
  })
})

test('~.. traversal is resolved by realpath and does not stay in home', () => {
  withTempHome((home) => {
    const physical = realpathSync.native(home)
    // `~/..` is a legal way to spell the home directory's parent; realpath
    // resolves it, and the result is that real parent, not the temp home.
    assert.equal(validateRoot('~/..'), resolve(physical, '..'))
    assert.equal(validateRoot('~/./..'), resolve(physical, '..'))
    assert.notEqual(validateRoot('~/..'), physical)
    // `~/../<basename of the temp home>` comes back to the temp home itself.
    const base = physical.split('/').pop()
    assert.equal(validateRoot(`~/../${base}`), physical)
  })
})

test('removalCandidates resolves ~ to the stored physical spelling', () => {
  withTempHome((home) => {
    const physical = realpathSync.native(home)
    const sub = join(physical, 'sub')
    mkdirSync(sub)
    // The physical spelling comes first: that is what the store persists.
    assert.equal(removalCandidates('~/sub')[0], sub)
    assert.ok(removalCandidates('~/sub').includes(expandHome('~/sub')))
    // An unresolvable path still yields candidates, so removal stays a no-op.
    assert.ok(removalCandidates('~/does-not-exist').length > 0)
    // `~user` cannot be expanded, so the raw spelling is the only candidate.
    assert.deepEqual(removalCandidates('~root/x'), ['~root/x'])
    assert.deepEqual(removalCandidates(''), [])
  })
})

test('a store keyed by a ~ grant round-trips as the physical path', () => {
  // The end-to-end contract: adding `~/sub` must store exactly the same string
  // as adding the absolute path, so the decoration sees one canonical root.
  withTempHome((home) => {
    const physical = realpathSync.native(home)
    const sub = join(physical, 'sub')
    mkdirSync(sub)
    const { store } = tempStore()
    store.add('/ws/one', validateRoot('~/sub'))
    store.add('/ws/one', validateRoot(sub))
    assert.deepEqual(store.get('/ws/one'), [sub], 'both spellings must collapse to one root')
  })
})

// ---------------------------------------------------------------------------
// Workspace-relative paths: a relative path is resolved against the workspace
// directory passed as `base`, never against process.cwd(). Without a base a
// relative path is still refused, so an old caller cannot silently grant a
// directory based on where the host process happened to start.
// ---------------------------------------------------------------------------

test('validateRoot resolves a relative path against the workspace base', () => {
  const workspace = tempDir()
  const affiliate = join(workspace, 'other-repo')
  mkdirSync(affiliate)

  assert.equal(validateRoot('other-repo', workspace), affiliate)
  assert.equal(validateRoot('./other-repo', workspace), affiliate)
  // A parent traversal is resolved by realpath, exactly like an absolute path.
  const parent = resolve(workspace, '..')
  assert.equal(validateRoot('..', workspace), parent)
})

test('validateRoot refuses a relative path when no base is supplied', () => {
  // Backwards compatibility and safety: the older one-argument call must keep
  // rejecting relative paths. The regression guard in scripts/verify relies on it.
  assert.throws(() => validateRoot('relative/path'), /must be absolute/)
  assert.throws(() => validateRoot('./x'), /must be absolute/)
  assert.throws(() => validateRoot('..'), /must be absolute/)
  // An empty/blank base is also refused, rather than falling back to process cwd.
  assert.throws(() => validateRoot('relative/path', ''), /must be absolute/)
})

test('validateRoot still enforces every rule on a base-resolved relative path', () => {
  const workspace = tempDir()
  // A symlink reached relatively is refused just like an absolute one. Creating
  // a symlink needs a privilege on Windows (Developer Mode / admin), so guard it
  // and keep the other assertions runnable everywhere.
  const link = join(workspace, 'link')
  try {
    symlinkSync(tempDir(), link)
    assert.throws(() => validateRoot('link', workspace), /physical path, not a symlink/)
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error
  }
  // Missing and file paths keep their dedicated errors.
  assert.throws(() => validateRoot('nope', workspace), /not readable/)
  const file = join(workspace, 'f.txt')
  writeFileSync(file, 'x')
  assert.throws(() => validateRoot('f.txt', workspace), /must be a directory/)
})

test('relative and absolute spellings of the same directory collapse to one root', () => {
  const workspace = tempDir()
  const affiliate = join(workspace, 'other-repo')
  mkdirSync(affiliate)
  const { store } = tempStore()
  store.add('/ws/one', validateRoot('other-repo', workspace))
  store.add('/ws/one', validateRoot(affiliate))
  assert.deepEqual(store.get('/ws/one'), [affiliate], 'relative and absolute spellings must be one canonical root')
})

test('removalCandidates resolves a relative path against the workspace base', () => {
  const workspace = tempDir()
  const affiliate = join(workspace, 'other-repo')
  mkdirSync(affiliate)

  // The physical spelling comes first and matches what a relative add stored.
  assert.equal(removalCandidates('other-repo', workspace)[0], affiliate)
  assert.ok(removalCandidates('./other-repo', workspace).includes(affiliate))
  // Without a base the raw spelling is still returned (a removal no-op), never
  // resolved against process.cwd().
  assert.ok(removalCandidates('other-repo').includes('other-repo'))
})

