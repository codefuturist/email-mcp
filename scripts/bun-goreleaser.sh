#!/usr/bin/env bash
# GoReleaser bun-builder wrapper.
#
# goreleaser-pro 2.18.2 passes an empty argument when `flags:` is non-empty
# (bun: "error: Invalid Argument ''"), so the performance flags live here
# instead. Drop this wrapper and use `flags: ["--minify", "--bytecode"]`
# once the upstream bug is fixed.
set -euo pipefail
BUN="${BUN_INSTALL:-$HOME/.local/share/bun}/bin/bun"
command -v "$BUN" >/dev/null 2>&1 || BUN=bun
exec "$BUN" "$@" --minify --bytecode
