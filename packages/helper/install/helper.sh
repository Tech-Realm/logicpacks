#!/usr/bin/env bash
# LogicPacks helper installer: curl -fsSL https://logicpacks.io/helper.sh | bash
# Installs lp, one standalone executable (no Node, npm or anything else needed), for macOS
# (Apple silicon or Intel) and Linux x64. It checks the SHA-256 against
# https://downloads.logicpacks.io/helper/latest.json. Re-running it upgrades lp in place.
# Optional: LP_SERVER=https://your-host LP_TOKEN=... to sign in during install,
# LP_HELPER_URL to install from another copy (with LP_HELPER_SHA256 to pin it),
# LP_HELPER_INSTALL=1 to also run `lp install --yes` (Claude Code hooks, background watcher, MCP),
# with LP_HELPER_NO_WATCHER=1 / LP_HELPER_NO_HOOKS=1 to skip parts of it.
# By default this only puts the lp command in place: it changes no agent's settings.
set -euo pipefail

HOME_DIR="${LP_HELPER_HOME:-$HOME/.logicpacks/helper}"
BIN_DIR="${LP_BIN_DIR:-$HOME/.local/bin}"
BASE="${LOGICPACKS_DOWNLOADS:-https://downloads.logicpacks.io}"

fail() { printf 'LogicPacks helper: %s\n' "$1" >&2; exit 1; }
sha256() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1"; else sha256sum "$1"; fi | awk '{print $1}'; }

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Darwin)
    # A shell under Rosetta reports x86_64 on Apple silicon: install the native build.
    if [ "$ARCH" = "x86_64" ] && [ "$(sysctl -in sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then ARCH=arm64; fi
    case "$ARCH" in arm64) TARGET=darwin-arm64 ;; x86_64) TARGET=darwin-x64 ;; *) fail "no build for macOS $ARCH." ;; esac ;;
  Linux)
    case "$ARCH" in x86_64 | amd64) TARGET=linux-x64 ;; *) fail "no build for Linux $ARCH yet (x64 only)." ;; esac ;;
  *) fail "this installer is for macOS and Linux. On Windows run in PowerShell: irm https://logicpacks.io/helper.ps1 | iex" ;;
esac

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/lp-helper.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT
TMP="$TMP_DIR/lp"

if [ -n "${LP_HELPER_URL:-}" ]; then
  SOURCE="$LP_HELPER_URL"
  EXPECTED="${LP_HELPER_SHA256:-}"
else
  curl -fsSL "$BASE/helper/latest.json" -o "$TMP_DIR/latest.json" || fail "could not reach $BASE/helper/latest.json"
  # latest.json keeps each build on one line: "<target>": { "url": ..., "sha256": ..., "size": ... }
  LINE="$(grep "\"$TARGET\"" "$TMP_DIR/latest.json" || true)"
  SOURCE="$(printf '%s' "$LINE" | sed -n 's/.*"url": *"\([^"]*\)".*/\1/p')"
  EXPECTED="$(printf '%s' "$LINE" | sed -n 's/.*"sha256": *"\([0-9a-f]\{64\}\)".*/\1/p')"
  [ -n "$SOURCE" ] && [ -n "$EXPECTED" ] || fail "the release manifest has no $TARGET build."
fi
case "$SOURCE" in
  http://* | https://*) curl -fsSL "$SOURCE" -o "$TMP" || fail "could not download $SOURCE" ;;
  file://*) cp "${SOURCE#file://}" "$TMP" ;;
  *) cp "$SOURCE" "$TMP" ;;
esac
if [ -n "$EXPECTED" ]; then
  ACTUAL="$(sha256 "$TMP")"
  [ "$ACTUAL" = "$EXPECTED" ] || fail "checksum mismatch for $SOURCE (expected $EXPECTED, got $ACTUAL). Nothing was installed."
fi
chmod 755 "$TMP"
"$TMP" help 2>/dev/null | grep -q LogicPacks || fail "$SOURCE is not a working lp for this computer."

mkdir -p "$HOME_DIR/bin" "$BIN_DIR"
# Replace by rename: a running watcher keeps the old file until it restarts.
mv -f "$TMP" "$HOME_DIR/bin/lp"
ln -sf "$HOME_DIR/bin/lp" "$BIN_DIR/lp"
# Point a watcher or MCP server that an older lp installed at this one (adds nothing new).
"$HOME_DIR/bin/lp" install --refresh --yes >/dev/null 2>&1 || true
# The older helper was a Node script.
rm -f "$HOME_DIR/lp.mjs"

if [ -n "${LP_HELPER_INSTALL:-}" ]; then
  INSTALL_ARGS=(--yes)
  [ -n "${LP_HELPER_NO_HOOKS:-}" ] && INSTALL_ARGS+=(--no-hooks)
  [ -n "${LP_HELPER_NO_WATCHER:-}" ] && INSTALL_ARGS+=(--no-watcher)
  "$HOME_DIR/bin/lp" install "${INSTALL_ARGS[@]}"
fi
printf 'Installed %s (%s) and %s. No agent settings were changed.\n' "$BIN_DIR/lp" "$("$HOME_DIR/bin/lp" version)" "$HOME_DIR"

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
"$BIN_DIR/lp" help | grep -q LogicPacks || fail "lp did not start after installing."
if [ -n "${LP_SERVER:-}" ]; then
  "$HOME_DIR/bin/lp" login --host "$LP_SERVER" ${LP_TOKEN:+--token "$LP_TOKEN"}
else
  printf '\nNext: %s login\n' "$LP_CMD"
fi
printf 'LogicPacks helper installed. Run %s status to check it.\n' "$LP_CMD"
