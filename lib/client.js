window.__ModuleLoader__.load({
  id: 'dsh-sub-workspace',
  factory: function (_require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    /**
     * dsh-sub-workspace — client (browser) half.
     *
     * Adds 「附属工作区」 management to the sidebar workspace row:
     *   - a `附属工作区…` entry inside the workspace row's right-click menu;
     *   - choosing it opens a panel listing that workspace's affiliate paths with
     *     add / remove.
     *
     * ## Which rows are decorated
     *
     * Only real workspace rows. The sidebar interleaves workspace, folder, session
     * and session-group rows in ONE tree, and they share the `bw-row` class, so the
     * row type is decided structurally (see `isWorkspaceRow`) — never by matching
     * the label text against workspace names. A session's title is user text and,
     * for a new session, is just the directory name, which made the old
     * label-matching filter decorate sessions that shared a workspace's name.
     *
     * ## Why DOM decoration instead of a slot
     *
     * The sidebar is drawn by `dsh-better-workspace`, which owns its own React tree
     * and hard-codes its workspace context-menu items — it exposes no plugin slot
     * there. Rather than fork that package, this module follows the approach the
     * shipped `dsh-workspace-color-tags` plugin uses: watch the sidebar DOM
     * (`div[data-row-key="workspace:<id>"]`), and decorate it from outside.
     *
     * ## Why the injected item survives React
     *
     * The host menu is a React portal that owns its children, so a plain
     * `appendChild` can be dropped by the next commit. Two guards keep the entry
     * present without fighting the host:
     *
     *   1. the entry is appended after the menu mounts (next animation frame), not
     *      during the React render;
     *   2. a MutationObserver re-appends it whenever the menu is still open but the
     *      entry was removed — the same resync pattern color-tags uses for its rows.
     *
     * If the host menu markup ever changes so the menu cannot be found, this module
     * silently does nothing: it never breaks the host menu.
     *
     * ## Data flow
     *
     * All state lives in the host half. The browser only calls the three
     * authenticated `/api/sub-workspace/*` routes, so the UI cannot grant a path the
     * host would refuse (symlink / missing / non-directory are all rejected
     * server-side with a readable reason).
     *
     * @module dsh-sub-workspace/client
     */

    const PLUGIN = 'dsh-sub-workspace'
    // `dsh-better-workspace` draws its own sidebar: a row is
    // `div.bw-row[role="treeitem"]` with its label in `.bw-row-label`. These rows
    // have NO `data-row-key` (that attribute belongs to the official sidebar this
    // plugin replaces).
    const ROW_SELECTOR = '.bw-row[role="treeitem"]'
    const LABEL_SELECTOR = '.bw-row-label'
    // Fallback for the official sidebar, which does use data-row-key.
    const OFFICIAL_ROW_SELECTOR = '[data-row-key^="workspace:"]'
    const TRIGGER_ATTR = 'data-subworkspace-trigger'
    /** Class on the row trigger button; its styles live in the injected sheet. */
    const TRIGGER_CLASS = 'sws-trigger'
    const PANEL_CLASS = 'sws-panel'

    /* ----------------------------------------------------------------- rows --
     *
     * Every row shape `dsh-better-workspace` draws, as measured on a live DSH page
     * (all 116 sidebar rows of a real profile) and cross-checked against the
     * host's own renderers (dsh-better-workspace/src/client.js — FolderRow,
     * WorkspaceRow, SessionRow, SessionGroupRow):
     *
     *   workspace row   div.bw-row[role=treeitem]                 (+ .bw-row-current)
     *                   chevron · icon · label · [count] · actions
     *   folder row      div.bw-row[role=treeitem]
     *                   chevron · icon · label · [count]           (NO actions)
     *   session row     div.bw-row.bw-session-row[role=treeitem]  (+ .bw-row-current,
     *                   icon · label · time · actions               .bw-row-archived)
     *   session group   div.bw-row.bw-sgroup-row[role=treeitem]
     *                   chevron · label · [count]                  (NO icon)
     *   overflow row    button.bw-row.bw-overflow-row              (not a treeitem)
     *
     * The old filter matched a row's LABEL against workspace titles and directory
     * basenames, so a session whose title happened to equal a workspace name — a
     * new session is titled after its directory — was decorated as that
     * workspace. The filter is now structural and label-free:
     *
     *   1. reject the classes that name a non-workspace shape outright
     *      (`.bw-session-row`, `.bw-sgroup-row`, `.bw-overflow-row`);
     *   2. require the parts a workspace row renders. That step is what separates a
     *      workspace row from a FOLDER row, the only other row carrying no
     *      distinguishing class: `FolderRow` renders chevron · icon · label
     *      · [count] and stops there, while `WorkspaceRow` always appends the
     *      `.bw-row-actions` slot. (Session rows also render an actions slot, but
     *      step 1 has already rejected them by class.)
     *   3. fail closed: a row we do not recognise is never decorated.
     */
    const NON_WORKSPACE_ROW_CLASSES = ['bw-session-row', 'bw-sgroup-row', 'bw-overflow-row']
    /** Parts a workspace row renders; `.bw-row-actions` is what a folder row lacks. */
    const WORKSPACE_ROW_PARTS = ['.bw-chevron', '.bw-row-icon', '.bw-row-actions', LABEL_SELECTOR]

    /** Whether a node carries one class token (no classList: test stubs lack it). */
    function hasClass(node, token) {
      return String(node.className ?? '').split(/\s+/).includes(token)
    }

    /** A row's visible label text. */
    function rowLabel(row) {
      const labelEl = row.querySelector(LABEL_SELECTOR)
      return (labelEl?.textContent ?? '').trim()
    }

    /**
     * Structural test: is this `dsh-better-workspace` row a workspace row?
     *
     * Label-free on purpose. A label is user text: a session title, a folder name
     * or another workspace's name can equal any other label at any moment, so it
     * can never decide what a row *is*.
     */
    function isWorkspaceRow(row) {
      if (row.getAttribute('role') !== 'treeitem') return false
      if (!hasClass(row, 'bw-row')) return false
      for (const token of NON_WORKSPACE_ROW_CLASSES) {
        if (hasClass(row, token)) return false
      }
      for (const part of WORKSPACE_ROW_PARTS) {
        if (row.querySelector(part) === null) return false
      }
      return true
    }

    /**
     * The `workspace` prop the host's own `WorkspaceRow` rendered a row from.
     *
     * React keeps the fiber on the DOM node, so BOTH the fact "this is a workspace
     * row" and the directory it stands for are readable without matching any text.
     * The caller still checks the path against the host's published list before
     * trusting it, and falls back to the row's shape for host builds that expose no
     * fiber.
     */
    function renderedWorkspaceProps(row) {
      try {
        const key = Object.keys(row).find((name) => name.startsWith('__reactFiber$'))
        if (key === undefined) return undefined
        let fiber = row[key]
        for (let hops = 0; fiber !== null && fiber !== undefined && hops < 8; hops += 1) {
          if (typeof fiber.type === 'function' && fiber.type.name === 'WorkspaceRow') {
            const props = fiber.memoizedProps
            return props === null || props === undefined ? undefined : props.workspace
          }
          fiber = fiber.return
        }
      } catch {
        /* React internals unavailable (or a different host build): no hint. */
      }
      return undefined
    }

    /** One JSON request against the host bridge. */
    async function api(path, init) {
      const response = await fetch(path, { credentials: 'same-origin', ...init })
      const text = await response.text()
      let value
      try {
        value = text === '' ? {} : JSON.parse(text)
      } catch {
        throw new Error(`unexpected response from ${path}`)
      }
      if (!response.ok) throw new Error(value?.error ?? `请求失败（${response.status}）`)
      return value
    }

    const loadAll = () => api('/api/sub-workspace/list')

    const mutate = (workspace, action, payload) =>
      api('/api/sub-workspace/mutate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace, action, ...payload }),
      })

    /** Inject the panel stylesheet once. */
    function installStyles() {
      if (document.querySelector(`style[data-plugin="${PLUGIN}"]`) !== null) return
      const style = document.createElement('style')
      style.setAttribute('data-plugin', PLUGIN)
      // Every colour / radius / shadow / font below is a token the host really
      // defines (verified with getComputedStyle against the live DSH page). There
      // are deliberately NO literal colour fallbacks: a fallback only applies when
      // the token is missing, so a literal fallback means a token that does not
      // exist silently paints a fixed colour and breaks in the other theme. That is
      // exactly how the old `var(--dsw-alias-bg-elevated, #fff)` produced a white
      // panel with near-white text.
      //
      // The surface recipe is copied from the host's own menu material
      // (_material_1w4el_21 / _media_bgejw_80): translucent fill + backdrop blur +
      // prominent elevation + 16px radius + hairline border, so this panel belongs
      // to the same visual family as native DSH popovers.
      style.textContent = `
        .${PANEL_CLASS}{position:fixed;z-index:2147483000;box-sizing:border-box;width:440px;max-height:70vh;
          overflow:auto;padding:10px;
          font-family:var(--dsw-font-family);font-size:calc(var(--dsh-content-font-size,14px) - 1px);
          color:var(--dsw-alias-label-primary);
          background:var(--dsw-menu-surface-fill);
          -webkit-backdrop-filter:var(--dsw-menu-backdrop-filter);
          backdrop-filter:var(--dsw-menu-backdrop-filter);
          box-shadow:var(--dsw-elevation-prominent);
          border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg)}
        .${PANEL_CLASS} h4{margin:0 0 6px;padding:2px 4px 3px;font-size:inherit;font-weight:600;
          display:flex;align-items:center;justify-content:space-between;gap:8px;
          color:var(--dsw-alias-label-primary)}
        .${PANEL_CLASS} .sws-path{margin:0 0 8px;padding:0 4px;line-height:1.5;word-break:break-all;
          font-size:calc(var(--dsh-content-font-size,14px) - 2px);color:var(--dsw-alias-label-tertiary)}
        .${PANEL_CLASS} ul{list-style:none;margin:0 0 8px;padding:0;
          display:flex;flex-direction:column;gap:4px}
        .${PANEL_CLASS} li{display:flex;align-items:center;gap:8px;padding:5px 8px;
          border-radius:var(--dsw-radius-md);
          background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);
          color:var(--dsw-alias-label-primary)}
        .${PANEL_CLASS} li span{flex:1;min-width:0;word-break:break-all;font-size:inherit;line-height:1.45}
        .${PANEL_CLASS} button{display:inline-flex;align-items:center;justify-content:center;gap:4px;flex:none;
          box-sizing:border-box;height:28px;padding:0 12px;border:none;border-radius:var(--dsw-radius-md);
          background:transparent;color:var(--dsw-alias-label-primary);
          font-family:var(--dsw-font-family);font-size:inherit;line-height:20px;cursor:pointer;
          transition:background-color .12s ease}
        .${PANEL_CLASS} button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
        .${PANEL_CLASS} button:disabled{cursor:not-allowed;opacity:.4}
        .${PANEL_CLASS} button:focus-visible{outline:var(--dsw-focus-ring-width) solid
          var(--dsw-alias-state-business-primary);outline-offset:-2px}
        .${PANEL_CLASS} button.primary{background:var(--dsw-alias-button-primary-fill);
          color:var(--dsw-alias-label-primary-foreground);padding:0 14px}
        .${PANEL_CLASS} button.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
        .${PANEL_CLASS} button.danger{color:var(--dsw-alias-state-error-primary);padding:0 8px}
        .${PANEL_CLASS} button.danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
        .${PANEL_CLASS} .sws-row{display:flex;gap:8px;align-items:center;padding:0 2px}
        .${PANEL_CLASS} input[type=text]{flex:1;min-width:0;height:30px;box-sizing:border-box;padding:0 10px;
          font-family:var(--dsw-font-family);font-size:inherit;
          border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l3);
          background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
        .${PANEL_CLASS} input[type=text]::placeholder{color:var(--dsw-alias-label-tertiary);opacity:1}
        .${PANEL_CLASS} input[type=text]:focus-visible{outline:var(--dsw-focus-ring-width) solid
          var(--dsw-alias-state-business-primary);outline-offset:-1px}
        .${PANEL_CLASS} .sws-msg{margin-top:8px;padding:0 4px;line-height:1.5;word-break:break-all;
          font-size:calc(var(--dsh-content-font-size,14px) - 2px);color:var(--dsw-alias-label-secondary)}
        .${PANEL_CLASS} .sws-msg.ok{color:var(--dsw-alias-label-secondary)}
        .${PANEL_CLASS} .sws-msg.err{color:var(--dsw-alias-state-error-primary)}
        .${PANEL_CLASS} li.sws-empty{display:block;padding:10px;text-align:center;background:transparent;
          border-color:transparent;font-size:calc(var(--dsh-content-font-size,14px) - 2px);
          color:var(--dsw-alias-label-tertiary)}
        .sws-trigger{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;
          -webkit-text-stroke:0;
          box-sizing:border-box;height:20px;margin-left:6px;padding:0 6px;border:none;
          border-radius:var(--dsw-radius-sm);background:transparent;
          color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-family);
          font-size:calc(var(--dsh-content-font-size,14px) - 3px);line-height:1;cursor:pointer;
          transition:background-color .12s ease,color .12s ease}
        .sws-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
        .sws-trigger:focus-visible{outline:var(--dsw-focus-ring-width) solid
          var(--dsw-alias-state-business-primary);outline-offset:-2px}
      `
      document.head?.appendChild(style)
    }

    /**
     * Client plugin body.
     * @param {object} ctx - client cordis context.
     */
        function apply(ctx) {
      installStyles()

      const state = {
        /** The open affiliate panel, or null. */
        panel: null,
        /** Directory the open panel belongs to. */
        panelDir: undefined,
        observer: null,
        frame: 0,
        /** workspaceId -> directory path, refreshed from the host. */
        dirById: new Map(),
      }

      /** Refresh the id → directory map the host publishes. */
      const refreshDirMap = async () => {
        try {
          const data = await loadAll()
          const next = new Map()
          for (const item of data.workspaces) {
            if (typeof item.id === 'string' && item.id !== '') next.set(item.id, item.workspace)
          }
          state.dirById = next
        } catch {
          /* keep the previous map: the menu simply won't offer a directory */
        }
      }

      /** Resolve a row id to the directory key the host stores under. */
      const dirForId = async (workspaceId) => {
        if (state.dirById.has(workspaceId)) return state.dirById.get(workspaceId)
        await refreshDirMap()
        return state.dirById.get(workspaceId)
      }

      /** Remove every injected row trigger. */
      const clearTriggers = () => {
        for (const node of document.querySelectorAll('[data-subworkspace-trigger]')) node.remove()
      }

      /** Close the affiliate panel. */
      const closePanel = () => {
        if (state.panel !== null) state.panel.remove()
        state.panel = null
        state.panelDir = undefined
      }

      /** Status line inside the panel. */
      const showMessage = (text, isError = false) => {
        if (state.panel === null) return
        let node = state.panel.querySelector('.sws-msg')
        if (node === null) {
          node = document.createElement('div')
          state.panel.appendChild(node)
        }
        node.className = `sws-msg ${isError ? 'err' : 'ok'}`
        node.textContent = text
      }

      /** One removable affiliate row. */
      const rootRow = (workspace, root) => {
        const li = document.createElement('li')
        const span = document.createElement('span')
        span.textContent = root
        const remove = document.createElement('button')
        remove.className = 'danger'
        remove.textContent = '移除'
        remove.addEventListener('click', async () => {
          remove.disabled = true
          try {
            await mutate(workspace, 'remove', { path: root })
            await refreshPanel(workspace)
            showMessage('已移除，下一次工具调用即刻生效')
          } catch (error) {
            showMessage(error.message, true)
            remove.disabled = false
          }
        })
        li.append(span, remove)
        return li
      }

      /** Re-render the open panel's list from the host. */
      const refreshPanel = async (workspace) => {
        if (state.panel === null) return
        let data
        try {
          data = await loadAll()
        } catch (error) {
          showMessage(`读取失败：${error.message}`, true)
          return
        }
        const mine = data.workspaces.find((item) => item.workspace === workspace)
        const roots = Array.isArray(mine?.roots) ? mine.roots : []
        const list = state.panel.querySelector('ul')
        if (list !== null) {
          if (roots.length === 0) {
            const empty = document.createElement('li')
            empty.className = 'sws-empty'
            empty.textContent = '暂无附属路径'
            // No inline background: `.sws-empty` clears both the fill and the
            // border from the stylesheet, so the empty state follows the theme.
            list.replaceChildren(empty)
          } else {
            list.replaceChildren(...roots.map((root) => rootRow(workspace, root)))
          }
        }
        const pathLine = state.panel.querySelector('.sws-path')
        if (pathLine !== null) {
          pathLine.textContent = roots.length === 0
            ? `工作区：${workspace}`
            : `工作区：${workspace} · ${roots.length} 条附属路径`
        }
      }

      /** Open the affiliate panel anchored at a viewport point. */
      const openPanel = async (workspace, point) => {
        closePanel()
        state.panelDir = workspace

        const panel = document.createElement('div')
        panel.className = PANEL_CLASS
        panel.setAttribute('data-plugin', PLUGIN)

        const heading = document.createElement('h4')
        heading.textContent = '附属工作区'
        const close = document.createElement('button')
        close.textContent = '关闭'
        close.addEventListener('click', closePanel)
        heading.appendChild(close)

        const pathLine = document.createElement('p')
        pathLine.className = 'sws-path'
        pathLine.textContent = `工作区：${workspace}`

        const list = document.createElement('ul')

        const inputRow = document.createElement('div')
        inputRow.className = 'sws-row'
        const input = document.createElement('input')
        input.type = 'text'
        input.placeholder = '绝对路径或 ~/，例如 ~/Git/other-repo'
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            add.click()
          }
        })
        const add = document.createElement('button')
        add.className = 'primary'
        add.textContent = '添加'
        add.addEventListener('click', async () => {
          const value = input.value.trim()
          if (value === '') {
            showMessage('请输入绝对路径或 ~/ 开头的路径', true)
            return
          }
          add.disabled = true
          try {
            await mutate(workspace, 'add', { path: value })
            input.value = ''
            await refreshPanel(workspace)
            showMessage('已添加，下一次工具调用即刻生效')
          } catch (error) {
            // The host refuses symlinks / missing / non-directory with a reason.
            showMessage(error.message, true)
          } finally {
            add.disabled = false
          }
        })
        inputRow.append(input, add)

        panel.append(heading, pathLine, list, inputRow)
        document.body.appendChild(panel)
        state.panel = panel

        // Keep the panel inside the viewport.
        const margin = 12
        const width = panel.offsetWidth
        const height = panel.offsetHeight
        const left = point.left + width + margin > window.innerWidth
          ? Math.max(margin, window.innerWidth - width - margin)
          : point.left
        const top = point.top + height + margin > window.innerHeight
          ? Math.max(margin, window.innerHeight - height - margin)
          : point.top
        panel.style.left = `${left}px`
        panel.style.top = `${top}px`

        await refreshPanel(workspace)
      }

      /**
       * Resolve ONE row to the directory the host stores affiliates under.
       *
       * Two independent proofs exist that a row IS a workspace row, and the row
       * must satisfy at least one of them before any decoration is considered:
       *
       *   - the `workspace` prop of the host's own `WorkspaceRow` fiber (that
       *     component is the only one that carries one), or
       *   - the workspace-row SHAPE (see `isWorkspaceRow`).
       *
       * The DIRECTORY then comes, most to least authoritative, from:
       *
       *   1. `data-row-key="workspace:<id>"` — the official sidebar names the
       *      workspace itself, so the id is the identity (unchanged behaviour);
       *   2. the fiber props: `path` when the host's list publishes that directory,
       *      else `workspaceId`;
       *   3. the row label — only after a proof above, and only when exactly one
       *      known workspace answers to it.
       *
       * Returns undefined whenever the row cannot be pinned down. "Do not
       * decorate" is always the safe answer; decorating the wrong workspace
       * grants the user the wrong write access.
       */
      const dirForRow = async (row, index) => {
        const key = row.getAttribute('data-row-key') ?? ''
        if (key.startsWith('workspace:')) return dirForId(key.slice('workspace:'.length))

        // The row must PROVE it is a workspace row, by either label-free proof:
        //   - the host's own `WorkspaceRow` props (only that component carries
        //     `workspace`, so a value here is conclusive), or
        //   - the workspace-row shape (see `isWorkspaceRow`).
        // No label, no decoration. A row that proves neither is never decorated.
        const rendered = renderedWorkspaceProps(row)
        if (rendered === undefined && !isWorkspaceRow(row)) return undefined

        if (rendered !== undefined) {
          const path = typeof rendered.path === 'string' ? rendered.path : ''
          if (path !== '' && index.knownDirs.has(path)) return path
          const id = typeof rendered.workspaceId === 'string' ? rendered.workspaceId : ''
          if (id !== '' && index.byId.has(id)) return index.byId.get(id)
        }

        // Directory unknown to the props (or no props readable on this host
        // build). The LABEL may now be consulted — the row type is already
        // proven — but only when exactly one workspace answers to it.
        return index.uniqueByLabel.get(rowLabel(row))
      }

      /**
       * Attach the 「附属工作区」 trigger to one workspace row.
       *
       * This node is OWNED by this plugin, appended inside the row. That is
       * deliberate: the host's right-click menu is a React portal that rebuilds
       * its children, so an injected menu item can be dropped mid-interaction.
       * A node we append to the row (and re-append on rebuild) has no such
       * problem, and it also works when the menu markup differs.
       */
      const decorateRow = (row, dir) => {
        if (row.querySelector('[data-subworkspace-trigger]') !== null) return
        const button = document.createElement('button')
        button.setAttribute('data-subworkspace-trigger', '1')
        button.type = 'button'
        button.title = '附属工作区'
        button.textContent = '附属'
        // Same shape/colour vocabulary as the host's own inline action button
        // (bw-icon-btn: transparent fill, --dsw-alias-label-secondary text,
        // --dsw-radius-sm corners, hover fill from --dsw-alias-interactive-bg-hover).
        // Every value lives in the stylesheet as a token; nothing is inline, so the
        // light/dark switch keeps working.
        button.className = TRIGGER_CLASS
        button.addEventListener('click', (event) => {
          // The row's own click toggles the workspace; don't let it interfere.
          event.preventDefault()
          event.stopPropagation()
          const rect = button.getBoundingClientRect()
          void openPanel(dir, { left: rect.left, top: rect.bottom + 4 })
        })
        button.addEventListener('contextmenu', (event) => {
          // Right-clicking our button should not open the host row menu.
          event.preventDefault()
          event.stopPropagation()
        })
        row.appendChild(button)
      }

      /**
       * Build the lookup tables one decoration pass resolves rows against.
       *
       * `uniqueByLabel` is deliberately sparse: a label that answers to more
       * than one workspace is dropped instead of guessed, because picking one of
       * them would offer the user write access to the *other* directory. Two
       * workspaces named `kafka` from different parents is a normal profile, not
       * a pathological case.
       */
      const buildIndex = (data) => {
        const knownDirs = new Set()
        const byId = new Map()
        const labelHits = new Map()
        const claim = (label, dir) => {
          if (label === '') return
          if (!labelHits.has(label)) labelHits.set(label, new Set())
          labelHits.get(label).add(dir)
        }
        const items = Array.isArray(data?.workspaces) ? data.workspaces : []
        for (const item of items) {
          const dir = typeof item.workspace === 'string' ? item.workspace : ''
          if (dir === '') continue
          knownDirs.add(dir)
          if (typeof item.id === 'string' && item.id !== '') byId.set(item.id, dir)
          if (typeof item.title === 'string' && item.title !== '') claim(item.title, dir)
          const base = dir.split('/').filter(Boolean).pop()
          if (base !== undefined) claim(base, dir)
        }
        const uniqueByLabel = new Map()
        for (const [label, dirs] of labelHits) {
          if (dirs.size === 1) uniqueByLabel.set(label, [...dirs][0])
        }
        return { knownDirs, byId, uniqueByLabel }
      }

      /**
       * Decorate every workspace row currently in the DOM.
       *
       * Only rows that pass the structural workspace test AND whose directory
       * resolves are decorated, so a session / group / folder row never gains a
       * trigger — not even when its title equals a workspace name.
       */
      const decorateRows = async () => {
        const rows = [...document.querySelectorAll(ROW_SELECTOR), ...document.querySelectorAll(OFFICIAL_ROW_SELECTOR)]
        if (rows.length === 0) return
        let data
        try {
          data = await loadAll()
        } catch {
          return
        }
        const index = buildIndex(data)
        for (const row of rows) {
          if (row.querySelector('[data-subworkspace-trigger]') !== null) continue
          const dir = await dirForRow(row, index)
          if (dir === undefined) continue
          decorateRow(row, dir)
        }
      }

      /** Pointer-down outside the panel closes it. */
      const onPointerDown = (event) => {
        if (state.panel === null) return
        const target = event.target
        if (target instanceof Node && state.panel.contains(target)) return
        closePanel()
      }

      /** Escape closes the panel. */
      const onKeyDown = (event) => {
        if (event.key !== 'Escape') return
        closePanel()
      }

      /** Remove everything this plugin added. */
      const teardown = () => {
        closePanel()
        clearTriggers()
        state.dirById = new Map()
        if (state.observer !== null) {
          state.observer.disconnect()
          state.observer = null
        }
        if (state.frame !== 0) {
          window.clearTimeout(state.frame)
          state.frame = 0
        }
        document.removeEventListener('mousedown', onPointerDown, true)
        document.removeEventListener('keydown', onKeyDown, true)
        document.querySelector(`style[data-plugin="${PLUGIN}"]`)?.remove()
      }

      ctx.effect(() => {
        // Rows are rebuilt by React on every list change, which drops our
        // trigger. Re-decorate on any subtree change; `decorateRows` is
        // idempotent (it skips rows that already carry a trigger).
        let scheduled = false
        const schedule = () => {
          if (scheduled) return
          scheduled = true
          const run = () => {
            scheduled = false
            void decorateRows()
          }
          if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(run)
          else setTimeout(run, 16)
        }
        // Observe `document` rather than `body`: at activation time the sidebar
        // may not be mounted yet, and React can replace the body's subtree. A
        // document-level subtree observer keeps firing through both.
        const observer = new MutationObserver(schedule)
        observer.observe(document, { childList: true, subtree: true })
        state.observer = observer

        document.addEventListener('mousedown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)

        // The observer alone proved unreliable for the initial mount (it fired
        // only while the sidebar was still empty, then never again). A short
        // bounded poll guarantees the first decoration happens once the rows
        // exist, and stops as soon as it succeeds.
        let attempts = 0
        const tick = () => {
          attempts += 1
          void decorateRows().then(() => {
            const done = document.querySelector('[data-subworkspace-trigger]') !== null
            if (!done && attempts < 40) {
              state.frame = window.setTimeout(tick, 250)
            }
          })
        }
        void refreshDirMap().then(tick)
        return teardown
      }, `${PLUGIN}: workspace row triggers`)
        }

    exports.apply = apply
    return module.exports
  },
})
