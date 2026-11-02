#!/bin/sh
set -eu

tag=${1:?usage: release.sh <mod>--v<version>}
printf '%s\n' "$tag" | grep -qE '^[a-z0-9-]+--v[0-9]+\.[0-9]+\.[0-9]+$' || { echo "release: '$tag' is not <mod>--v<x.y.z>" >&2; exit 1; }

mod=${tag%%--v*}
version=${tag##*--v}
dir="plugins/$mod"
[ -f "$dir/.claude-plugin/plugin.json" ] || { echo "release: no mod at $dir" >&2; exit 1; }

declared=$(node -p "require('./$dir/.claude-plugin/plugin.json').version")
[ "$declared" = "$version" ] || { echo "release: $dir/.claude-plugin/plugin.json says $declared, the tag says $version" >&2; exit 1; }

notes=$(awk -v v="$version" '
  $0 ~ "^## " { if (found) exit; found = ($2 == v) ; next }
  found { print }
' "$dir/CHANGELOG.md")
[ -n "$(printf '%s' "$notes" | tr -d '[:space:]')" ] || { echo "release: $dir/CHANGELOG.md has no entry for $version" >&2; exit 1; }

if gh release view "$tag" >/dev/null 2>&1; then echo "release: $tag already published"; exit 0; fi

printf '%s\n' "$notes" | gh release create "$tag" --verify-tag --title "$mod v$version" --notes-file -
