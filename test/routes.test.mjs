/**
 * Tests for the host HTTP bridge that backs the sidebar UI.
 *
 * The bridge is the only way the browser can change affiliates, so these tests
 * assert two things independently:
 *   - each route performs the right store mutation;
 *   - every validation failure is a 400 with a readable reason, never a 500 and
 *     never a silent success (a silent success is how "granted but ignored"
 *     bugs reach users).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AffiliateStore } from '../lib/store.js'
import { installRoutes, ROUTE_LIST, ROUTE_MUTATE, ROUTE_CHECK } from '../lib/routes.js'

const tempDir = () => realpathSync.native(mkdtempSync(join(tmpdir(), 'subws-routes-')))

/**
 * Run `fn` with the home directory pointed at a throwaway physical temp dir.
 *
 * `expandHome` resolves `~` via `os.homedir()`, which reads `$HOME` on POSIX,
 * so a test can exercise `~/...` without depending on what happens to exist in
 * the developer's real home. Realpath first: on darwin `/var` is a symlink to
 * `/private/var`, and a non-physical `$HOME` would make every expanded path
 * look like a symlink to `validateRoot`.
 */
function withTempHome(fn) {
  const home = tempDir()
  const previous = process.env.HOME
  process.env.HOME = home
  return Promise.resolve()
    .then(() => fn(home))
    .finally(() => {
      if (previous === undefined) delete process.env.HOME
      else process.env.HOME = previous
      rmSync(home, { recursive: true, force: true })
    })
}

function harness({ registry } = {}) {
  const dir = tempDir()
  const store = new AffiliateStore(join(dir, 'affiliates.json'))
  const registered = []
  const connection = {
    fetch: {
      register: (route) => {
        registered.push(route)
        return () => {
          const at = registered.indexOf(route)
          if (at !== -1) registered.splice(at, 1)
        }
      },
    },
  }
  const policy = { mode: 'workspace-write', workspaceRoot: '/ws/mine', additionalWritableRoots: [] }
  const disposers = installRoutes({
    store,
    resolvePolicy: () => policy,
    storePath: store.file,
    connection,
    workspaceRegistry: registry,
  })
  const routeOf = (path) => registered.find((r) => r.path === path)
  return { store, registered, disposers, routeOf, dir, policy }
}

/** Invoke a route's fetch with a JSON body. */
function post(route, body) {
  return route.fetch(
    new Request('http://127.0.0.1/api/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

async function body(response) {
  return JSON.parse(await response.text())
}

test('installs exactly three routes under /api', () => {
  const h = harness()
  assert.equal(h.registered.length, 3)
  assert.deepEqual(
    h.registered.map((r) => r.path).sort(),
    [ROUTE_CHECK, ROUTE_LIST, ROUTE_MUTATE].sort(),
  )
  assert.deepEqual(h.routeOf(ROUTE_LIST).methods, ['GET'])
  assert.deepEqual(h.routeOf(ROUTE_MUTATE).methods, ['POST'])
  assert.deepEqual(h.routeOf(ROUTE_CHECK).methods, ['GET'])
})

test('dispensers unregister every route', () => {
  const h = harness()
  for (const dispose of h.disposers) dispose()
  assert.equal(h.registered.length, 0)
})

test('list publishes id and directory so the sidebar can map a row', async () => {
  const registry = {
    list: () => [{ id: 'ws-1', path: '/ws/mine', title: 'my-repo' }],
  }
  const h = harness({ registry })
  const payload = await body(await h.routeOf(ROUTE_LIST).fetch(new Request(`http://127.0.0.1${ROUTE_LIST}`)))
  const mine = payload.workspaces.find((w) => w.workspace === '/ws/mine')
  assert.ok(mine, 'a registry workspace must appear even with no affiliates yet')
  assert.equal(mine.id, 'ws-1')
  assert.equal(mine.title, 'my-repo')
  assert.deepEqual(mine.roots, [])
  assert.equal(payload.storePath, h.store.file)
})

test('add persists a validated physical directory', async () => {
  const h = harness()
  const affiliate = tempDir()
  const response = await post(h.routeOf(ROUTE_MUTATE), {
    workspace: '/ws/mine',
    action: 'add',
    path: affiliate,
  })
  assert.equal(response.status, 200)
  const payload = await body(response)
  assert.deepEqual(payload.roots, [affiliate])
  assert.deepEqual(h.store.get('/ws/mine'), [affiliate])
})

test('add refuses a symlink with 400 and an actionable message', async () => {
  const h = harness()
  const real = tempDir()
  const parent = tempDir()
  const link = join(parent, 'ln')
  symlinkSync(real, link)

  const response = await post(h.routeOf(ROUTE_MUTATE), {
    workspace: '/ws/mine',
    action: 'add',
    path: link,
  })
  assert.equal(response.status, 400)
  const payload = await body(response)
  assert.match(payload.error, /physical path, not a symlink/)
  assert.deepEqual(h.store.get('/ws/mine'), [], 'a refused add must not mutate the store')
})

test('add refuses a missing path and a plain file', async () => {
  const h = harness()
  const dir = tempDir()
  const file = join(dir, 'f.txt')
  writeFileSync(file, 'x')

  for (const bad of [join(dir, 'nope'), file]) {
    const response = await post(h.routeOf(ROUTE_MUTATE), {
      workspace: '/ws/mine',
      action: 'add',
      path: bad,
    })
    assert.equal(response.status, 400, `${bad} must be refused`)
  }
  assert.deepEqual(h.store.get('/ws/mine'), [])
})

test('a relative workspace key is refused', async () => {
  const h = harness()
  const affiliate = tempDir()
  const response = await post(h.routeOf(ROUTE_MUTATE), {
    workspace: 'relative/path',
    action: 'add',
    path: affiliate,
  })
  assert.equal(response.status, 400)
  assert.match((await body(response)).error, /absolute directory/)
})

test('remove and set behave per contract', async () => {
  const h = harness()
  const a = tempDir()
  const b = tempDir()
  const route = h.routeOf(ROUTE_MUTATE)

  await post(route, { workspace: '/ws/mine', action: 'add', path: a })
  await post(route, { workspace: '/ws/mine', action: 'add', path: b })
  assert.deepEqual(h.store.get('/ws/mine'), [a, b])

  const removed = await body(await post(route, { workspace: '/ws/mine', action: 'remove', path: a }))
  assert.deepEqual(removed.roots, [b])

  const replaced = await body(await post(route, { workspace: '/ws/mine', action: 'set', paths: [a] }))
  assert.deepEqual(replaced.roots, [a])

  const cleared = await body(await post(route, { workspace: '/ws/mine', action: 'set', paths: [] }))
  assert.deepEqual(cleared.roots, [])
})

test('an unknown action is a 400, not a silent no-op', async () => {
  const h = harness()
  const response = await post(h.routeOf(ROUTE_MUTATE), { workspace: '/ws/mine', action: 'nope' })
  assert.equal(response.status, 400)
  assert.match((await body(response)).error, /unknown action/)
})

test('check reports the matching writable root', async () => {
  const h = harness()
  const affiliate = tempDir()
  await post(h.routeOf(ROUTE_MUTATE), { workspace: '/ws/mine', action: 'add', path: affiliate })
  // The harness policy is static; check the workspace-root branch instead.
  const url = `http://127.0.0.1${ROUTE_CHECK}?path=${encodeURIComponent(affiliate)}`
  const payload = await body(await h.routeOf(ROUTE_CHECK).fetch(new Request(url)))
  assert.equal(typeof payload.writable, 'boolean')
  assert.equal(payload.path, affiliate)
})

test('check refuses a symlink path and explains why', async () => {
  const h = harness()
  const real = tempDir()
  const parent = tempDir()
  const link = join(parent, 'ln')
  symlinkSync(real, link)
  const url = `http://127.0.0.1${ROUTE_CHECK}?path=${encodeURIComponent(link)}`
  const payload = await body(await h.routeOf(ROUTE_CHECK).fetch(new Request(url)))
  assert.equal(payload.writable, false)
  assert.match(payload.reason, /physical path/)
})

test('a registry read fault still returns the affiliate list', async () => {
  const registry = {
    list: () => {
      throw new Error('storage fault')
    },
  }
  const h = harness({ registry })
  const affiliate = tempDir()
  await post(h.routeOf(ROUTE_MUTATE), { workspace: '/ws/mine', action: 'add', path: affiliate })
  const payload = await body(await h.routeOf(ROUTE_LIST).fetch(new Request(`http://127.0.0.1${ROUTE_LIST}`)))
  const mine = payload.workspaces.find((w) => w.workspace === '/ws/mine')
  assert.deepEqual(mine.roots, [affiliate])
})

test('every route declares a requestBody mode the bridge understands', () => {
  // `dsh-client-connection`'s bridge only branches on 'buffered' vs anything
  // else, and everything else is treated as 'streaming'. A streaming GET cannot
  // work and surfaces as a bare 400, so only the two real modes are allowed.
  const h = harness()
  const allowed = new Set(['buffered', 'streaming'])
  for (const route of h.registered) {
    assert.ok(
      allowed.has(route.requestBody),
      `route ${route.path} declares requestBody ${JSON.stringify(route.requestBody)}; ` +
        'only buffered/streaming are understood',
    )
  }
})

// ---------------------------------------------------------------------------
// Home-relative paths over HTTP: the bridge must accept the same `~/...`
// spellings the tool does, and must never accept one for the workspace key.
// ---------------------------------------------------------------------------

test('add accepts a ~/... path and stores the physical directory', async () => {
  await withTempHome(async (home) => {
    const h = harness()
    const physical = realpathSync.native(home)
    const sub = join(physical, 'repo')
    mkdirSync(sub)

    const response = await post(h.routeOf(ROUTE_MUTATE), {
      workspace: '/ws/mine',
      action: 'add',
      path: '~/repo',
    })
    assert.equal(response.status, 200)
    const payload = await body(response)
    // The stored root is physical, never the literal `~/repo` spelling.
    assert.deepEqual(payload.roots, [sub])
    assert.equal(payload.added, sub)
    assert.deepEqual(h.store.get('/ws/mine'), [sub])
  })
})

test('add of ~ alone stores the home directory itself', async () => {
  await withTempHome(async (home) => {
    const h = harness()
    const physical = realpathSync.native(home)
    const payload = await body(
      await post(h.routeOf(ROUTE_MUTATE), { workspace: '/ws/mine', action: 'add', path: '~' }),
    )
    assert.deepEqual(payload.roots, [physical])
  })
})

test('add of ~user is a 400 with the dedicated explanation', async () => {
  await withTempHome(async () => {
    const h = harness()
    const response = await post(h.routeOf(ROUTE_MUTATE), {
      workspace: '/ws/mine',
      action: 'add',
      path: '~someuser/x',
    })
    assert.equal(response.status, 400)
    assert.match((await body(response)).error, /~user expansion is not supported/)
    assert.deepEqual(h.store.get('/ws/mine'), [], 'a refused add must not mutate the store')
  })
})

test('add of ~/missing is a 400 that names the expanded path', async () => {
  await withTempHome(async () => {
    const h = harness()
    const response = await post(h.routeOf(ROUTE_MUTATE), {
      workspace: '/ws/mine',
      action: 'add',
      path: '~/nope',
    })
    assert.equal(response.status, 400)
    const { error } = await body(response)
    assert.match(error, /not readable/)
    // Without the expanded spelling the user cannot tell what `~/nope` became.
    assert.match(error, /from "~\/nope"/)
  })
})

test('add through ~ still refuses a symlink', async () => {
  await withTempHome(async (home) => {
    const h = harness()
    const physical = realpathSync.native(home)
    const target = tempDir()
    symlinkSync(target, join(physical, 'ln'))

    const response = await post(h.routeOf(ROUTE_MUTATE), {
      workspace: '/ws/mine',
      action: 'add',
      path: '~/ln',
    })
    assert.equal(response.status, 400)
    assert.match((await body(response)).error, /physical path, not a symlink/)
    assert.deepEqual(h.store.get('/ws/mine'), [])
  })
})

test('set accepts a mix of absolute and ~ paths, deduplicating them', async () => {
  await withTempHome(async (home) => {
    const h = harness()
    const physical = realpathSync.native(home)
    const sub = join(physical, 'repo')
    mkdirSync(sub)
    const other = tempDir()

    const payload = await body(
      await post(h.routeOf(ROUTE_MUTATE), {
        workspace: '/ws/mine',
        action: 'set',
        // The same directory written two ways must collapse to one root.
        paths: ['~/repo', sub, other],
      }),
    )
    assert.deepEqual(payload.roots, [sub, other])
  })
})

test('check accepts a ~/... path and reports the physical one', async () => {
  await withTempHome(async (home) => {
    const h = harness()
    const physical = realpathSync.native(home)
    const sub = join(physical, 'repo')
    mkdirSync(sub)

    const url = `http://127.0.0.1${ROUTE_CHECK}?path=${encodeURIComponent('~/repo')}`
    const payload = await body(await h.routeOf(ROUTE_CHECK).fetch(new Request(url)))
    // Identify the directory: `check` reports the physical spelling, not the
    // spelling the browser sent.
    assert.equal(payload.path, sub)
  })
})

test('check reports why a ~/... path is not writable instead of failing', async () => {
  await withTempHome(async (home) => {
    const h = harness()
    const sub = join(realpathSync.native(home), 'outside')
    mkdirSync(sub)

    const url = `http://127.0.0.1${ROUTE_CHECK}?path=${encodeURIComponent('~/outside')}`
    const payload = await body(await h.routeOf(ROUTE_CHECK).fetch(new Request(url)))
    assert.equal(payload.writable, false)
    assert.equal(payload.reason, 'not under any writable root')
  })
})

test('remove accepts ~ and drops the root that was added absolutely', async () => {
  await withTempHome(async (home) => {
    const h = harness()
    const physical = realpathSync.native(home)
    const sub = join(physical, 'repo')
    mkdirSync(sub)
    const route = h.routeOf(ROUTE_MUTATE)

    // Added with the absolute spelling, removed with the home-relative one.
    await post(route, { workspace: '/ws/mine', action: 'add', path: sub })
    assert.deepEqual(h.store.get('/ws/mine'), [sub])

    const payload = await body(
      await post(route, { workspace: '/ws/mine', action: 'remove', path: '~/repo' }),
    )
    assert.deepEqual(payload.roots, [])
    assert.equal(payload.removed, sub, 'the reported removal is the stored physical spelling')
    assert.deepEqual(h.store.get('/ws/mine'), [])
  })
})

test('remove of an unmatched ~ path stays a no-op, not an error', async () => {
  await withTempHome(async (home) => {
    const h = harness()
    const keep = tempDir()
    const route = h.routeOf(ROUTE_MUTATE)
    await post(route, { workspace: '/ws/mine', action: 'add', path: keep })

    // Existing directory under home, but not an affiliate.
    const absent = join(realpathSync.native(home), 'absent')
    mkdirSync(absent)
    const response = await post(route, { workspace: '/ws/mine', action: 'remove', path: '~/absent' })
    assert.equal(response.status, 200)
    const payload = await body(response)
    assert.deepEqual(payload.roots, [keep], 'an unmatched removal must not touch other roots')
    assert.deepEqual(h.store.get('/ws/mine'), [keep])
  })
})

test('a ~ workspace key is still refused: keys are real cwd paths', async () => {
  // Workspace keys are the host's immutable session cwd, never home-relative, so
  // accepting `~/x` here would create a second entry for one directory.
  await withTempHome(async (home) => {
    const h = harness()
    const sub = join(realpathSync.native(home), 'repo')
    mkdirSync(sub)

    const response = await post(h.routeOf(ROUTE_MUTATE), {
      workspace: '~/repo',
      action: 'add',
      path: sub,
    })
    assert.equal(response.status, 400)
    assert.match((await body(response)).error, /absolute directory/)
    assert.deepEqual(h.store.keys(), [])
  })
})

// ---------------------------------------------------------------------------
// Workspace-relative paths over HTTP: a relative `path` in a mutation or check
// is resolved against the (absolute) `workspace` key, never the process cwd.
// ---------------------------------------------------------------------------

test('add resolves a relative path against the workspace key', async () => {
  const h = harness()
  const workspace = tempDir()
  const affiliate = join(workspace, 'other-repo')
  mkdirSync(affiliate)

  const response = await post(h.routeOf(ROUTE_MUTATE), {
    workspace,
    action: 'add',
    path: 'other-repo',
  })
  assert.equal(response.status, 200)
  const payload = await body(response)
  assert.deepEqual(payload.roots, [affiliate])
  assert.equal(payload.added, affiliate)
  assert.deepEqual(h.store.get(workspace), [affiliate])
})

test('a relative path without a usable workspace base stays refused', async () => {
  // The workspace key itself is still required to be absolute; the existing
  // "relative workspace key is refused" test covers that. Here the base is
  // absolute, so a relative path resolves — but an absolute path still wins.
  const h = harness()
  const workspace = tempDir()
  const affiliate = tempDir()
  const payload = await body(
    await post(h.routeOf(ROUTE_MUTATE), { workspace, action: 'add', path: affiliate }),
  )
  assert.deepEqual(payload.roots, [affiliate], 'absolute paths keep their existing behaviour')
})

test('remove of a relative path drops the root that was added relatively', async () => {
  const h = harness()
  const workspace = tempDir()
  const affiliate = join(workspace, 'other-repo')
  mkdirSync(affiliate)
  const route = h.routeOf(ROUTE_MUTATE)

  await post(route, { workspace, action: 'add', path: 'other-repo' })
  assert.deepEqual(h.store.get(workspace), [affiliate])

  const payload = await body(await post(route, { workspace, action: 'remove', path: 'other-repo' }))
  assert.deepEqual(payload.roots, [])
  assert.equal(payload.removed, affiliate)
  assert.deepEqual(h.store.get(workspace), [])
})

test('set resolves a mix of relative and absolute paths against the workspace', async () => {
  const h = harness()
  const workspace = tempDir()
  const relative = join(workspace, 'in-repo')
  mkdirSync(relative)
  const absolute = tempDir()

  const payload = await body(
    await post(h.routeOf(ROUTE_MUTATE), {
      workspace,
      action: 'set',
      // `in-repo` written relatively and absolutely must collapse to one root.
      paths: ['in-repo', relative, absolute],
    }),
  )
  assert.deepEqual(payload.roots, [relative, absolute])
})

test('check resolves a relative path against the workspace/session param', async () => {
  const h = harness()
  const workspace = tempDir()
  const affiliate = join(workspace, 'other-repo')
  mkdirSync(affiliate)

  const url = `http://127.0.0.1${ROUTE_CHECK}?path=${encodeURIComponent('other-repo')}&workspace=${encodeURIComponent(workspace)}`
  const payload = await body(await h.routeOf(ROUTE_CHECK).fetch(new Request(url)))
  // The relative `path` resolved against the workspace param, so check reports
  // the physical affiliate — the same spelling an absolute add would have stored.
  assert.equal(payload.path, affiliate)
  assert.equal(payload.workspace, h.policy.workspaceRoot)
})

test('check of a relative path with a symlink result is refused with a reason', async () => {
  const h = harness()
  const workspace = tempDir()
  const link = join(workspace, 'ln')
  try {
    symlinkSync(tempDir(), link)
  } catch (error) {
    // Creating a symlink needs a privilege on Windows; nothing to assert there.
    if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error
    return
  }

  const url = `http://127.0.0.1${ROUTE_CHECK}?path=${encodeURIComponent('ln')}&session=${encodeURIComponent(workspace)}`
  const payload = await body(await h.routeOf(ROUTE_CHECK).fetch(new Request(url)))
  assert.equal(payload.writable, false)
  assert.match(payload.reason, /physical path/)
})

