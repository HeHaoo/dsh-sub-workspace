# scripts/verify/shots

Screenshots and page checks that need the REAL DSH web UI, driven over CDP
(Chrome with `--remote-debugging-port=9334`; DSH on whatever port it is actually
running on — see below).

All scripts authenticate through `../lib/env.mjs` (secret from
`DSH_AUTH_SECRET` or `~/.dsh/.credentials.yaml`; never hardcoded) and connect
through `../lib/cdp.mjs`.

## Why injection instead of just reloading the page

The running DSH serves this plugin from its profile, so a plain reload can show
either a stale or an already-installed build. The checks below therefore inject
the LOCAL `lib/client.js` source into the real page and measure what that source
does — that is the only way to verify an edit without restarting DSH.

To be able to inject two different sources on the same page and tell their
effects apart, an injected copy has its trigger attribute renamed to
`data-swstest-trigger`. The attribute plays no part in deciding what a row is;
it only labels which source drew a button.

**Run these one at a time.** Every script here drives the SAME debug tab (one CDP
`page` target). Two runs at once tear down each other's injected copy and DOM
nodes; measured: three concurrent `capture.mjs` runs make one of them fail with
`the panel opens with the injected source — {"stage":"no-populated-panel"}`.
That is a concurrency artifact, not a plugin bug — a serial re-run passes.

## Scripts

| script | what it does | writes |
| --- | --- | --- |
| `verify-row-filter.mjs` | **The row-filter check.** Asserts that only workspace rows get a 「附属」 trigger and that no session / session-group / overflow row ever does. Also measures the legacy label-matching source on the same page (the reported bug: 17 of 76 session rows decorated) and confirms the injected fix decorates 39/39 workspace rows and 0 session rows. Additionally checks that 默认工作区 opens its own directory and that the WorkBuddy workspace row opens the WorkBuddy directory. | nothing |
| `capture.mjs` | Panel appearance check (background, contrast, radius, backdrop) in both themes; writes `panel-dark.png` / `panel-light.png`. | screenshots |
| `probe-rows.mjs` | Enumerates every `.bw-row` class variant and its structural make-up (children, attrs, computed padding-left, icon/count/label/chevron presence). This is where the row-type filter's evidence comes from. | nothing |
| `probe-identity.mjs` | For every row: its React owner component and, for `WorkspaceRow`, the `workspace` prop (path / id). Shows the directory is readable without matching label text. | nothing |
| `probe-page-state.mjs` | Health check of the shared debug tab after an injection run (no leftover test triggers, no stray panel, installed copy intact). | nothing |

## Running

Ports are resolved by `../lib/env.mjs`: DSH is `--port` → `DSH_PORT` → `PORT` → **default
52524**, and the CDP port is `--cdp-port` → `DSH_CDP_PORT` → `CDP_PORT` → **default 9334**.
52524 is a fallback, not a promise — pass the port DSH is actually on, or every
script here exits `2` with a `[precondition] DSH is not reachable` line:

```bash
export DSH_PORT=55736                     # or pass --port to each command

node scripts/verify/shots/verify-row-filter.mjs          # the acceptance check
node scripts/verify/shots/capture.mjs                    # appearance + screenshots (WRITES the PNGs)
node scripts/verify/shots/probe-rows.mjs                 # row-shape evidence
node scripts/verify/shots/probe-identity.mjs             # React fiber identity evidence
node scripts/verify/shots/probe-page-state.mjs           # tab health
```

Exit codes: `0` pass, `1` fail, `2` precondition missing (Chrome debug port
closed, DSH not listening, no credentials). **The three probes do not use `1`:**
they only print a measurement and exit `0` (or `2` when a precondition is
missing), so do not wire them into a gate — only `verify-row-filter.mjs` and
`capture.mjs` are assertion scripts here.

`verify-row-filter.mjs` takes `--legacy <path to an older lib/client.js>` to
compare against a different baseline. The default points at the PRE-MIGRATION
checkout of this plugin (`$DSH_SUBWORKSPACE_LEGACY`, else the developer's old
`default-workspace` copy). That path is a local convenience only — it is not
shipped with this repository. If it is gone the script reports `SKIP` for the
legacy comparison and still runs every other check; the acceptance assertions
do not depend on it.
