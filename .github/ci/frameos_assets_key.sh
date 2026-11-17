#!/usr/bin/env bash
# The compiled-assets cache key's hash: every input prepare_assets.py
# fingerprints (FRONTEND_SOURCE_FILES + REPO_ROOT_FILES there). With one
# missing, a change to it is a cache HIT followed by prepare_assets.py deciding
# to rebuild anyway, without Node on a hit: "pnpm or corepack is required",
# every shard red (frontend/scripts/generateRepoApps.mjs and
# frontend/package.json, 2026-09-20).
#
# This used to be a `hashFiles(...)` over the same paths, which walks the
# working tree: frameos/frontend/** took node_modules with it once pnpm had
# installed, and the post step evaluated it again after the build. On the
# runner pool it ran past GitHub's 120 s cap now and then and failed a job whose
# tests had passed. The index's blob ids say the same thing about the tracked
# files in milliseconds: a change to any of them changes the hash, and nothing
# untracked (node_modules, dist) is in it.
#
# Used by pull-request-tests.yml and e2e-docker.yml, which share the cache:
#   echo "key=${{ runner.os }}-frameos-assets-$(bash .github/ci/frameos_assets_key.sh)" >> "$GITHUB_OUTPUT"
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Pathspecs, not shell globs: a directory names everything under it, and the
# one wildcard goes through :(glob) so that `*` stays within a directory as it
# did in hashFiles.
paths=(
  frameos/frontend
  frameos/tools/prepare_assets.py
  ':(glob)frameos/tools/generate_*.py'
  frontend/src
  frontend/schema
  frontend/public
  frontend/scripts/generateRepoApps.mjs
  frontend/package.json
  repo
  package.json
  pnpm-workspace.yaml
  pnpm-lock.yaml
  versions.json
)

listing="$(git ls-files --stage -- "${paths[@]}")"
# An empty listing is a checkout without an index (or a path list gone wrong):
# a key that hashes nothing would hit one stale cache forever.
if [ -z "$listing" ]; then
  echo "frameos_assets_key.sh: git ls-files found none of the asset inputs" >&2
  exit 1
fi
printf '%s\n' "$listing" | sha256sum | cut -c1-64
