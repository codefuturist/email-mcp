#!/usr/bin/env bash
# Build standalone email-mcp binaries for release.
#
# Compiles src/main.ts with Bun for every supported platform — minified and
# bytecode-precompiled (~32 ms cold start, no Node.js required at runtime) —
# then packages each as a .tar.gz (.zip on Windows) next to a sha256
# checksums file, ready for `gh release upload` (and consumable via mise's
# ubi backend). CI runs this from the Release workflow's binaries job.
set -euo pipefail

cd "$(dirname "$0")/.."

# PATH first (CI installs bun via oven-sh/setup-bun), standalone install second.
BUN="${BUN:-$(command -v bun || echo "${BUN_INSTALL:-$HOME/.local/share/bun}/bin/bun")}"
VERSION=$(node -p "require('./package.json').version" 2>/dev/null || "$BUN" -p "require('./package.json').version")
OUT="build/release"

TARGETS=(
  "bun-darwin-arm64:darwin-arm64"
  "bun-darwin-x64:darwin-x64"
  "bun-linux-x64:linux-x64"
  "bun-linux-arm64:linux-arm64"
  "bun-windows-x64-modern:windows-x64"
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
  if [[ "$label" == windows-* ]]; then
    # Bun appends .exe for Windows targets; zip is the platform convention.
    (cd "$dir" && zip -q "../email-mcp-${VERSION}-${label}.zip" email-mcp.exe)
  else
    tar -czf "$OUT/email-mcp-${VERSION}-${label}.tar.gz" -C "$dir" email-mcp
  fi
  rm -rf "$dir"
done

# Bare filenames keep the file `sha256sum -c` / `shasum -c` compatible.
(cd "$OUT" && shasum -a 256 ./*.tar.gz ./*.zip | sed 's| \./| |' > "email-mcp-${VERSION}-checksums.txt")

echo
echo "Artifacts in $OUT:"
ls -lh "$OUT"
