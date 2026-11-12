/**
 * The model-facing `sub_workspace` tool.
 *
 * Affiliate roots are a *management* concern, not a hot path, so they are
 * managed through one small tool rather than by asking the model to edit files.
 * Every mutating action validates the directory eagerly (see `paths.js`) and
 * persists through the atomic store, then reports the effective root list so the
 * model can confirm what the sandbox will now accept.
 *
 * Paths may be written as `~/...` (and as bare `~`); see `expandHome` in
 * paths.js. `~someuser` is refused rather than guessed.
 *
 * Actions:
 *   list    — every workspace key with its roots, plus the current session's
 *   add     — append one validated root to the calling session's workspace
 *   remove  — drop one root from the calling session's workspace
 *   set     — replace the calling session's workspace roots wholesale
 *   check   — report whether a path would be writable under the current policy
 *
 * The definition uses the real `ctx.tools.register` contract: `parameters` is a
 * field map (not JSON Schema), and `output` must carry both `schema` and
 * `render`.
 *
 * @module dsh-sub-workspace/tool
 */

import { isUnder, removalCandidates, validateRoot } from './paths.js'

/** Read the immutable cwd of the calling session, or refuse with an actionable message. */
function cwdOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd === '') {
    throw new Error(
      'sub_workspace: this call has no Session workspace to attach affiliates to; affiliates are per workspace directory',
    )
  }
  return cwd
}

/** Report the cwd without throwing — used for read-only reporting. */
function cwdOfSafe(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/** Validate every proposed root, preserving order and dropping exact duplicates. */
function validateAll(paths) {
  const out = []
  for (const entry of paths) {
    const physical = validateRoot(entry)
    if (!out.includes(physical)) out.push(physical)
  }
  return out
}

/**
 * Build the tool definition.
 *
 * @param {object} deps
 * @param {import('./store.js').AffiliateStore} deps.store
 * @param {(request: object) => object} deps.resolvePolicy - the decorated resolve.
 * @param {string} deps.storePath - for diagnostics.
 * @param {{warn: (message: string) => void}} deps.log
 */
export function buildTool(deps) {
  const { store, resolvePolicy, storePath, log } = deps

  /** Snapshot of the decorated policy for the calling session. */
  const policyOf = (exec) => {
    const session = exec?.agent?.session
    if (session === undefined) return undefined
    try {
      return resolvePolicy({ session })
    } catch (error) {
      log.warn(`sub-workspace: policy resolve failed: ${error?.message ?? error}`)
      return undefined
    }
  }

  return {
    name: 'sub_workspace',
    description: [
      'Manage workspace affiliate directories: extra absolute paths the sandbox additionally allows this workspace to WRITE, on top of the session workspace root.',
      'Affiliates apply to every Session of the same workspace directory (including already-running historical Sessions) and take effect on the next tool call.',
      'Official write / edit / bash honor them because the live sandbox policy is decorated — no official code is replaced.',
      'Entries must be existing physical directories; symlinks are rejected so a grant cannot be redirected.',
      'Paths may be written absolutely or with a leading ~ (`~/Git/repo`, or bare `~` for the home directory); ~someuser is refused rather than guessed.',
      'Actions: list (all workspaces + current), add (one path), remove (one path), set (replace the whole list), check (would this path be writable now).',
    ].join(' '),
    // Written directly as JSON Schema: `ctx.tools.register` takes the model-facing
    // `parameters` as-is (only `defineTool` compiles a field map, and importing
    // `@deepseek-ai/dsh-tools` from a profile plugin is not resolvable).
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'add', 'remove', 'set', 'check'],
          description: 'Which management action to run: list | add | remove | set | check.',
        },
        path: {
          type: 'string',
          description:
            'Single directory path. Required for add, remove, and check. Absolute, or home-relative with a leading ~ (`~/Git/repo`, or bare `~`); ~someuser is not supported.',
        },
        paths: {
          type: 'array',
          description:
            'Replacement list of directory paths. Required for set; an empty array clears every affiliate. Each entry is absolute or home-relative with a leading ~.',
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          storePath: { type: 'string', required: true, description: 'Where affiliates are persisted.' },
          currentWorkspace: { type: 'string', description: 'Immutable directory of the calling Session.' },
          workspaces: {
            type: 'array',
            description: 'Every workspace key with its affiliate roots (list action).',
          },
          mine: {
            type: 'array',
            description: 'Affiliate roots of the calling Session workspace.',
          },
          sandbox: {
            type: 'object',
            description: 'Effective policy: mode, workspaceRoot, additionalWritableRoots.',
          },
          writable: { type: 'boolean', description: 'check: whether the path is writable now.' },
          reason: { type: 'string', description: 'check: why it is or is not writable.' },
          matchedRoot: { type: 'string', description: 'check: the writable root the path falls under.' },
          path: { type: 'string', description: 'check: the physical path examined.' },
          workspace: { type: 'string', description: 'The workspace key the mutation applied to.' },
          added: { type: 'string', description: 'add: the root that was added.' },
          removed: { type: 'string', description: 'remove: the root that was dropped.' },
        },
      },
      render(_args, value) {
        return { type: 'text', text: JSON.stringify(value) }
      },
    },

    async execute(args, exec) {
      const action = String(args?.action ?? '')
      const policy = policyOf(exec)

      const report = (extra = {}) => ({
        storePath,
        currentWorkspace: cwdOfSafe(exec),
        sandbox:
          policy === undefined
            ? undefined
            : {
                mode: policy.mode,
                workspaceRoot: policy.workspaceRoot,
                additionalWritableRoots: policy.additionalWritableRoots ?? [],
                // resolve() runs per call, so this is exactly what the model is
                // told on the very next step — and what the next write enforces.
                effectiveNow: true,
              },
        ...extra,
      })

      switch (action) {
        case 'list': {
          const workspaces = store.keys().map((key) => ({ workspace: key, roots: store.get(key) }))
          const current = cwdOfSafe(exec)
          return report({ workspaces, mine: current === undefined ? [] : store.get(current) })
        }

        case 'add': {
          const key = cwdOf(exec)
          const [root] = validateAll([args?.path])
          if (root === undefined) throw new Error('sub_workspace: add requires a path')
          const mine = store.add(key, root)
          return report({ workspace: key, mine, added: root })
        }

        case 'remove': {
          const key = cwdOf(exec)
          const raw = String(args?.path ?? '').trim()
          if (raw === '') throw new Error('sub_workspace: remove requires a path')
          // Roots are stored physically, so a ~/x argument has to resolve to the
          // stored spelling before the exact-match removal can hit. Matching no
          // candidate is a no-op, exactly like an unknown absolute path.
          let removed = raw
          let mine = store.get(key)
          for (const candidate of removalCandidates(raw)) {
            const next = store.remove(key, candidate)
            // A changed length means this spelling was the stored one; stop so
            // one call still removes at most one root, as documented.
            if (next.length !== mine.length) {
              removed = candidate
              mine = next
              break
            }
          }
          return report({ workspace: key, mine, removed })
        }

        case 'set': {
          const key = cwdOf(exec)
          if (!Array.isArray(args?.paths)) {
            throw new Error('sub_workspace: set requires a paths array (may be empty to clear)')
          }
          store.set(key, validateAll(args.paths))
          return report({ workspace: key, mine: store.get(key) })
        }

        case 'check': {
          const raw = String(args?.path ?? '').trim()
          if (raw === '') throw new Error('sub_workspace: check requires a path')
          let physical
          try {
            physical = validateRoot(raw)
          } catch (error) {
            return report({ path: raw, writable: false, reason: error.message })
          }
          if (policy === undefined) {
            return report({ path: physical, writable: false, reason: 'no session policy available' })
          }
          if (policy.mode === 'read-only') {
            return report({ path: physical, writable: false, reason: 'sandbox mode is read-only' })
          }
          if (policy.mode === 'danger-full-access') {
            return report({ path: physical, writable: true, reason: 'danger-full-access is unrestricted' })
          }
          const roots = [policy.workspaceRoot, ...(policy.additionalWritableRoots ?? [])]
          const hit = roots.find((root) => isUnder(physical, root))
          return report({
            path: physical,
            writable: hit !== undefined,
            matchedRoot: hit,
            reason: hit === undefined ? 'not under any writable root' : 'under a writable root',
          })
        }

        default:
          throw new Error(`sub_workspace: unknown action ${JSON.stringify(action)}`)
      }
    },
  }
}
