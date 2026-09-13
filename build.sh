#!/usr/bin/env sh
# Stages the runtime files into dist/ as a folder Chrome can load unpacked, and
# zips the same set. A Manifest V3 extension is plain JS, so there is nothing to
# compile; this only collects files and skips .git/ and test/.

set -eu

cd "$(dirname "$0")"

version=$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' manifest.json)
name="x-affiliate-muter-blocker-$version"
files="manifest.json content.js sniffer.js sniffer-inject.js README.md LICENSE.md icons/icon16.png icons/icon32.png icons/icon48.png icons/icon128.png"

stage="dist/$name"
archive="dist/$name.zip"

# Scoped to the versioned path computed above, so dist/ itself survives.
rm -rf "$stage"
rm -f "$archive"
mkdir -p "$stage"

# Relative paths are preserved, since the manifest names icons/icon16.png.
for file in $files; do
  mkdir -p "$stage/$(dirname "$file")"
  cp "$file" "$stage/$file"
done

( cd "$stage" && zip -q -X "../$name.zip" $files )

echo "load unpacked from : $stage"
echo "portable archive   : $archive"
