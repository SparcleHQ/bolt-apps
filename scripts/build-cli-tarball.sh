#!/bin/sh
# Builds the bolt-apps CLI release tarball and its SHA256SUMS. Deterministic: the same commit gives the same bytes.
#   scripts/build-cli-tarball.sh <out-dir>
# Needs GNU tar (on macOS: brew install gnu-tar, found as gtar), gzip, git, node, and sha256sum or shasum.
#
# In the tarball (under one folder, bolt-apps-<version>/): the launchers, toolkit (bin, lib, package.json, README),
# schema, kit (python, schema, conformance, and the examples that `bolt-apps new` copies), the top-level docs/*.md, LICENSE, NOTICE, README.md.
# Left out on purpose: toolkit/test, kit/python/tests, apps/, docs/images, docs/gallery.json, .github, scripts.
set -eu

out=${1:-}
[ -n "$out" ] || { echo "usage: $0 <out-dir>" >&2; exit 2; }
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
cd "$root"

tar_bin=tar
if ! tar --version 2>/dev/null | grep -q 'GNU tar'; then
  if command -v gtar >/dev/null 2>&1; then tar_bin=gtar; else echo "build-cli-tarball: GNU tar is required (gtar on macOS)" >&2; exit 2; fi
fi

version=$(node -p "JSON.parse(require('fs').readFileSync('toolkit/package.json','utf8')).version")
case "$version" in ''|*[!0-9A-Za-z.+-]*) echo "build-cli-tarball: bad version '$version'" >&2; exit 2 ;; esac
name="bolt-apps-$version"
# a fixed clock: the commit time, so a rebuild of the same commit is byte-identical
epoch=${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct)}

mkdir -p "$out"
out=$(CDPATH= cd -- "$out" && pwd -P)
list=$(mktemp)
tmp_tar=$(mktemp)
tmp_gz=$(mktemp)
trap 'rm -f "$list" "$tmp_tar" "$tmp_gz"' EXIT INT TERM

# tracked files only, so nothing local (keys, caches, .boltpack files) can ride along
git ls-files -- bolt-apps bolt-apps.cmd LICENSE NOTICE README.md toolkit schema kit docs \
  | grep -v -e '^toolkit/test/' -e '^kit/python/tests/' -e '/__pycache__/' -e '\.pyc$' -e '\.boltpack$' \
  | grep -e '^bolt-apps' -e '^LICENSE$' -e '^NOTICE$' -e '^README.md$' -e '^toolkit/' -e '^schema/' -e '^kit/' -e '^docs/[^/]*\.md$' \
  | LC_ALL=C sort -u > "$list"

for must in bolt-apps bolt-apps.cmd toolkit/bin/bolt-apps.mjs toolkit/package.json schema/bolt-rules.json kit/examples/index.json kit/python/bolt_app_engine.py LICENSE; do
  grep -qx "$must" "$list" || { echo "build-cli-tarball: $must is not tracked in this checkout" >&2; exit 1; }
done

tarball="$out/$name.tar.gz"
# tar to a temp file first, then gzip, then move into place: a failed tar (a pipe hides its exit code under plain sh)
# can never leave a truncated tarball or a SHA256SUMS that vouches for one. set -e stops the script at the failing step.
"$tar_bin" --create --file="$tmp_tar" --files-from="$list" \
    --transform "s,^,$name/," \
    --sort=name --mtime="@$epoch" --owner=0 --group=0 --numeric-owner --mode='u+rwX,go+rX,go-w'
gzip -n -9 < "$tmp_tar" > "$tmp_gz"
cat "$tmp_gz" > "$tarball"

cd "$out"
if command -v sha256sum >/dev/null 2>&1; then sha256sum "$name.tar.gz" > SHA256SUMS
else shasum -a 256 "$name.tar.gz" > SHA256SUMS; fi
echo "built $tarball ($(wc -c < "$tarball" | tr -d ' ') bytes, $(wc -l < "$list" | tr -d ' ') files)"
cat SHA256SUMS
