#!/usr/bin/env bash
# Build standalone email-mcp binaries for release.
#
# Compiles src/main.ts with Bun for every supported platform — minified and
# bytecode-precompiled (~32 ms cold start, no Node.js required at runtime) —
# then packages each as a .tar.gz next to a sha256 checksums file, ready for
# `gh release upload` (and consumable via mise's ubi backend).
set -euo pipefail

cd "$(dirname "$0")/.."

BUN="${BUN:-${BUN_INSTALL:-$HOME/.local/share/bun}/bin/bun}"
VERSION=$(node -p "require('./package.json').version" 2>/dev/null || "$BUN" -p "require('./package.json').version")
OUT="build/release"

TARGETS=(
  "bun-darwin-arm64:darwin-arm64"
  "bun-darwin-x64:darwin-x64"
  "bun-linux-x64:linux-x64"
  "bun-linux-arm64:linux-arm64"
)

rm -rf "$OUT"
mkdir -p "$OUT"

for entry in "${TARGETS[@]}"; do
  target="${entry%%:*}"
  label="${entry##*:}"
  dir="$OUT/email-mcp-${VERSION}-${label}"
  mkdir -p "$dir"
  echo "── ${label} ──"
  "$BUN" build --compile --minify --bytecode --target="$target" \
    src/main.ts --outfile "$dir/email-mcp"
  tar -czf "$OUT/email-mcp-${VERSION}-${label}.tar.gz" -C "$dir" email-mcp
  rm -rf "$dir"
done

(cd "$OUT" && shasum -a 256 ./*.tar.gz > "email-mcp-${VERSION}-checksums.txt")

echo
echo "Artifacts in $OUT:"
ls -lh "$OUT"
