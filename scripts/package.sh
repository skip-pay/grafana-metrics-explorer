#!/usr/bin/env bash
# Packs the build in dist/ into artifacts/<id>-<version>.zip (top-level directory <id>/, no source maps) and
# writes its SHA-256 checksum next to it. Run `npm run build` first.
set -euo pipefail

cd "$(dirname "$0")/.."
id=$(node -p "require('./src/plugin.json').id")
version=$(node -p "require('./package.json').version")
zip_name="$id-$version.zip"
out="$PWD/artifacts"

if [ ! -f dist/plugin.json ] || [ ! -f dist/module.js ]; then
  echo "dist/ holds no build; run npm run build first" >&2
  exit 1
fi

staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
mkdir "$staging/$id"
cp -R dist/. "$staging/$id/"
find "$staging/$id" -name '*.map' -delete

mkdir -p "$out"
rm -f "$out/$zip_name" "$out/$zip_name.sha256"
(cd "$staging" && zip -qrX "$out/$zip_name" "$id")
(cd "$out" && shasum -a 256 "$zip_name" > "$zip_name.sha256")
echo "artifacts/$zip_name"
