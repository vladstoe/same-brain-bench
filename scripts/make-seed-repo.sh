#!/usr/bin/env bash
# Builds the repo the rig clones for each attempt: seed/ as one commit on `main`,
# tagged seed-v2. Author, committer and dates are fixed, so every build of the same
# seed/ gives the same commit hash.
#
# usage: scripts/make-seed-repo.sh [target]    (default: .seed-repo in the repo root)
set -euo pipefail

root=$(cd -- "$(dirname -- "$0")/.." && pwd)
target=${1:-"$root/.seed-repo"}
case $target in /*) ;; *) target="$PWD/$target" ;; esac

# Only a seed repo this script built may be replaced.
if [ -e "$target" ] && ! git -C "$target" rev-parse -q --verify refs/tags/seed-v2 >/dev/null 2>&1; then
  echo "refusing to replace $target: it is not a seed repo built by this script" >&2
  exit 1
fi

build=$(mktemp -d "${TMPDIR:-/tmp}/seed-repo.XXXXXX")
trap 'rm -rf "$build"' EXIT
cp -R "$root/seed/." "$build/"

# The user's own git settings must not reach the commit: no hooks, no signing,
# no line-ending rewrites, no global ignore file.
g() {
  git -C "$build" -c core.hooksPath=/dev/null -c commit.gpgSign=false -c tag.gpgSign=false \
    -c core.autocrlf=false -c core.excludesFile=/dev/null "$@"
}

export GIT_AUTHOR_NAME=same-brain-bench GIT_AUTHOR_EMAIL=seed@same-brain-bench.invalid
export GIT_COMMITTER_NAME=same-brain-bench GIT_COMMITTER_EMAIL=seed@same-brain-bench.invalid
export GIT_AUTHOR_DATE=2026-10-04T15:29:00+02:00 GIT_COMMITTER_DATE=2026-10-04T15:29:00+02:00

g init -q -b main
g add -A
g commit -q --no-verify -m "feat: library API with catalogue, circulation, fines, reporting and permissions"
g tag seed-v2

rm -rf "$target"
mkdir -p "$(dirname -- "$target")"
mv "$build" "$target"
trap - EXIT

echo "seed repo $target"
echo "seed-v2 $(git -C "$target" rev-parse seed-v2)"
