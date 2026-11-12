#!/usr/bin/env bash
#
# install.sh - install dsh-sub-workspace into a DSH profile.
#
# File writes only. This script NEVER runs pnpm and never touches ~/.dsh beyond
# the one profile you name. What it does:
#
#   1. Creates <profile>/node_modules/dsh-sub-workspace as a symlink to THIS
#      checkout (relinks if it already points somewhere else).
#   2. Ensures "dsh-sub-workspace" is listed in <profile>/package.json at
#      dsh.profile.bundles, so DSH actually loads the bundle.
#   3. Rewrites a stale "link:..." entry in <profile>/package.json dependencies
#      if it points at a different checkout (e.g. the pre-migration location).
#
# Idempotent: a second run reports "already up to date" and writes nothing.
#
# Usage:
#   ./scripts/install.sh                      # install into the default profile
#   ./scripts/install.sh --dry-run            # print actions, write nothing
#   ./scripts/install.sh --profile web
#   ./scripts/install.sh --dsh-home /path/to/dsh-home
#
# After a real install, restart DSH so the bundle is picked up.

set -euo pipefail

PLUGIN_NAME="dsh-sub-workspace"
PROFILE="desktop"
DRY_RUN=0
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --profile) shift; PROFILE="${1:-}" ;;
    --profile=*) PROFILE="${1#*=}" ;;
    --dsh-home) shift; DSH_HOME_DIR="${1:-}" ;;
    --dsh-home=*) DSH_HOME_DIR="${1#*=}" ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1 (try --help)" >&2; exit 64 ;;
  esac
  shift
done

if [ -z "$PROFILE" ]; then echo "error: --profile needs a value" >&2; exit 64; fi
if [ -z "$DSH_HOME_DIR" ]; then echo "error: --dsh-home needs a value" >&2; exit 64; fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
PLUGIN_SRC="$(cd "$SCRIPT_DIR/.." && pwd)"
# Physical spelling of the same directory. `pwd` above may keep a symlinked
# path (e.g. /tmp vs /private/tmp on darwin, or a symlinked checkout); comparing
# a RESOLVED link target against a non-resolved source can never match.
PLUGIN_SRC_PHYSICAL="$(cd "$SCRIPT_DIR/.." && pwd -P)"
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
PKG_JSON="$PROFILE_DIR/package.json"
NM_DIR="$PROFILE_DIR/node_modules"
LINK_PATH="$NM_DIR/$PLUGIN_NAME"
LINK_TARGET="link:$PLUGIN_SRC"

say() { printf '%s\n' "$*"; }
act() {
  if [ "$DRY_RUN" = 1 ]; then printf '[dry-run] would %s\n' "$*"; else printf '[write]   %s\n' "$*"; fi
}

say "dsh-sub-workspace installer"
say "  plugin source : $PLUGIN_SRC"
say "  dsh home      : $DSH_HOME_DIR"
say "  profile       : $PROFILE"
if [ "$DRY_RUN" = 1 ]; then say "  mode          : DRY RUN (no files will be written)"; fi
say ""

# ---------- preflight: fail before writing anything ----------
if [ ! -f "$PLUGIN_SRC/package.json" ]; then
  echo "error: $PLUGIN_SRC/package.json not found - run this from the plugin checkout" >&2
  exit 1
fi
if [ ! -f "$PLUGIN_SRC/lib/index.js" ]; then
  echo "error: $PLUGIN_SRC/lib/index.js not found - the checkout looks incomplete" >&2
  exit 1
fi

DECLARED_NAME="$(node -e 'process.stdout.write(require(process.argv[1]).name || "")' "$PLUGIN_SRC/package.json")"
if [ "$DECLARED_NAME" != "$PLUGIN_NAME" ]; then
  echo "error: $PLUGIN_SRC/package.json declares name \"$DECLARED_NAME\", expected \"$PLUGIN_NAME\"" >&2
  exit 1
fi
if [ ! -d "$PROFILE_DIR" ]; then
  echo "error: profile directory not found: $PROFILE_DIR" >&2
  echo "       available profiles under $DSH_HOME_DIR/profiles:" >&2
  ls -1 "$DSH_HOME_DIR/profiles" 2>/dev/null | sed 's/^/         /' >&2 || true
  exit 1
fi
if [ ! -f "$PKG_JSON" ]; then
  echo "error: $PKG_JSON not found - is $PROFILE_DIR a DSH profile?" >&2
  exit 1
fi

# ---------- step 1: node_modules symlink ----------
say "== step 1/2: profile node_modules symlink =="
if [ ! -d "$NM_DIR" ]; then
  act "create directory $NM_DIR"
  if [ "$DRY_RUN" = 0 ]; then mkdir -p "$NM_DIR"; fi
fi

if [ -L "$LINK_PATH" ]; then
  CURRENT_TARGET="$(readlink "$LINK_PATH")"
  # Compare RESOLVED paths, not raw link text. A link may legitimately store a
  # relative target (pnpm and a plain `ln -s` both produce relative links), so a
  # literal string comparison against our absolute "$PLUGIN_SRC" reported
  # "needs relink" even when the link already pointed exactly where we want —
  # which made every dry run look like a pending install.
  #
  # Resolve through the DIRECTORY the link is in. `cd -P "$LINK_PATH"` follows
  # the link only when the link is valid; for a dangling link the cd fails and
  # CURRENT_RESOLVED stays empty, so a broken link still compares as wrong and
  # gets replaced.
  CURRENT_RESOLVED=""
  if [ -d "$LINK_PATH" ]; then
    CURRENT_RESOLVED="$(cd -P "$LINK_PATH" 2>/dev/null && pwd -P)"
  fi
  if [ "$CURRENT_RESOLVED" = "$PLUGIN_SRC_PHYSICAL" ]; then
    say "  symlink already correct: $LINK_PATH -> $CURRENT_TARGET (resolves to $CURRENT_RESOLVED)"
  else
    act "relink $LINK_PATH (currently -> $CURRENT_TARGET)"
    if [ "$DRY_RUN" = 0 ]; then
      rm -f "$LINK_PATH"
      ln -s "$PLUGIN_SRC" "$LINK_PATH"
    fi
  fi
elif [ -e "$LINK_PATH" ]; then
  echo "error: $LINK_PATH exists but is not a symlink; refusing to replace a real directory" >&2
  echo "       remove it yourself if you are sure, then re-run." >&2
  exit 1
else
  act "create symlink $LINK_PATH -> $PLUGIN_SRC"
  if [ "$DRY_RUN" = 0 ]; then ln -s "$PLUGIN_SRC" "$LINK_PATH"; fi
fi
say ""

# ---------- step 2: package.json (bundles + stale link: dependency) ----------
say "== step 2/2: $PKG_JSON =="
SW_PKG="$PKG_JSON" SW_NAME="$PLUGIN_NAME" SW_LINK="$LINK_TARGET" SW_DRY="$DRY_RUN" \
node -e "$(cat <<'NODE_EOF'
const fs = require('fs');
const file = process.env.SW_PKG;
const name = process.env.SW_NAME;
const link = process.env.SW_LINK;
const dry = process.env.SW_DRY === '1';

let doc;
try {
  doc = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (err) {
  console.error('  error: cannot parse ' + file + ': ' + err.message);
  process.exit(2);
}

const changes = [];
const notes = [];

if (doc.dependencies && Object.prototype.hasOwnProperty.call(doc.dependencies, name)) {
  const current = doc.dependencies[name];
  if (current !== link) {
    doc.dependencies[name] = link;
    changes.push('dependencies["' + name + '"]: "' + current + '" -> "' + link + '"');
  }
} else {
  notes.push('dependencies["' + name + '"] is absent; left as-is (use "pnpm add file:..." for a lockfile-durable entry)');
}

doc.dsh = doc.dsh || {};
doc.dsh.profile = doc.dsh.profile || {};
if (!Array.isArray(doc.dsh.profile.bundles)) {
  doc.dsh.profile.bundles = [];
  changes.push('initialised dsh.profile.bundles as an empty array');
}
if (!doc.dsh.profile.bundles.includes(name)) {
  doc.dsh.profile.bundles.push(name);
  changes.push('appended "' + name + '" to dsh.profile.bundles');
}

for (const note of notes) console.log('  note: ' + note);

if (changes.length === 0) {
  console.log('  already up to date: "' + name + '" is in dsh.profile.bundles');
  process.exit(0);
}

for (const change of changes) {
  console.log(dry ? '  [dry-run] would set ' + change : '  [write]   set ' + change);
}
if (!dry) {
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  console.log('  wrote ' + file);
}
NODE_EOF
)"
say ""

# ---------- done ----------
if [ "$DRY_RUN" = 1 ]; then
  say "Dry run complete. Nothing was written. Re-run without --dry-run to apply."
else
  say "Installed. Restart DSH to load the bundle."
  say "Note: this script does not run pnpm. If you later run 'pnpm install' in"
  say "      $PROFILE_DIR, the dependency entry above keeps the link in place."
fi
