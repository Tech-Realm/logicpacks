#!/usr/bin/env bash
# LogicPacks helper installer: curl -fsSL https://logicpacks.io/helper.sh | bash
# Optional: LP_SERVER=https://your-host LP_TOKEN=... to sign in during install,
# LP_HELPER_URL to install from another copy, LP_HELPER_SHA256 to pin it,
# LP_HELPER_INSTALL=1 to also run `lp install --yes` (Claude Code hooks, background watcher, MCP),
# with LP_HELPER_NO_WATCHER=1 / LP_HELPER_NO_HOOKS=1 to skip parts of it.
# By default this only puts the lp command in place: it changes no agent's settings.
set -euo pipefail

HOME_DIR="${LP_HELPER_HOME:-$HOME/.logicpacks/helper}"
SOURCE="${LP_HELPER_URL:-https://logicpacks.io/helper/lp.mjs}"
BIN_DIR="${LP_BIN_DIR:-$HOME/.local/bin}"

fail() { printf 'LogicPacks helper: %s\n' "$1" >&2; exit 1; }

NODE="$(command -v node || true)"
[ -n "$NODE" ] || fail "Node.js 18 or newer is needed (Claude Code and Codex already use it). Install it from https://nodejs.org and run this again."
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || fail "Node.js 18 or newer is needed; found $("$NODE" -v)."

mkdir -p "$HOME_DIR/bin" "$BIN_DIR"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/lp-helper.XXXXXX")"
TMP="$TMP_DIR/lp.mjs"
trap 'rm -rf "$TMP_DIR"' EXIT
case "$SOURCE" in
  http://* | https://*) curl -fsSL "$SOURCE" -o "$TMP" || fail "could not download $SOURCE" ;;
  file://*) cp "${SOURCE#file://}" "$TMP" ;;
  *) cp "$SOURCE" "$TMP" ;;
esac
if [ -n "${LP_HELPER_SHA256:-}" ]; then
  ACTUAL="$(shasum -a 256 "$TMP" 2>/dev/null || sha256sum "$TMP")"
  [ "${ACTUAL%% *}" = "$LP_HELPER_SHA256" ] || fail "checksum mismatch for $SOURCE"
fi
"$NODE" --check "$TMP" 2>/dev/null || fail "$SOURCE is not a valid helper script"
mv "$TMP" "$HOME_DIR/lp.mjs"

# Hooks and the watcher call this wrapper, so they keep working when PATH differs.
cat > "$HOME_DIR/bin/lp" <<WRAPPER
#!/bin/sh
exec "$NODE" "$HOME_DIR/lp.mjs" "\$@"
WRAPPER
chmod 755 "$HOME_DIR/bin/lp"
ln -sf "$HOME_DIR/bin/lp" "$BIN_DIR/lp"

if [ -n "${LP_HELPER_INSTALL:-}" ]; then
  INSTALL_ARGS=(--yes)
  [ -n "${LP_HELPER_NO_HOOKS:-}" ] && INSTALL_ARGS+=(--no-hooks)
  [ -n "${LP_HELPER_NO_WATCHER:-}" ] && INSTALL_ARGS+=(--no-watcher)
  "$HOME_DIR/bin/lp" install "${INSTALL_ARGS[@]}"
fi
printf 'Installed %s (the lp command) and %s. No agent settings were changed.\n' "$BIN_DIR/lp" "$HOME_DIR"

# macOS and many Linux systems ship a printer command named lp; say which one runs.
LP_CMD=lp
FOUND="$(command -v lp || true)"
if [ "$FOUND" != "$BIN_DIR/lp" ] && [ "$FOUND" != "$HOME_DIR/bin/lp" ]; then
  LP_CMD="$BIN_DIR/lp"
  case ":$PATH:" in
    *":$BIN_DIR:"*) printf 'Note: %s (the printer command) comes before %s on your PATH. Call %s, or put %s first.\n' "$FOUND" "$BIN_DIR" "$LP_CMD" "$BIN_DIR" ;;
    *) printf 'Add %s to the front of your PATH to type lp from any terminal; until then call %s.\n' "$BIN_DIR" "$LP_CMD" ;;
  esac
fi
if [ -n "${LP_SERVER:-}" ]; then
  "$HOME_DIR/bin/lp" login --host "$LP_SERVER" ${LP_TOKEN:+--token "$LP_TOKEN"}
else
  printf '\nNext: %s login\n' "$LP_CMD"
fi
printf 'LogicPacks helper installed. Run %s status to check it.\n' "$LP_CMD"
