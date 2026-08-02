#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Deploys used to stream `git archive` of this directory into
# /usr/local/bin/frameos-cloud-update on the server, which reinstalled and
# rebuilt it against a cloud-local pnpm-lock.yaml. Since the workspaces were
# unified there is no cloud-local lockfile and workspace: dependencies
# resolve against the monorepo, so that server contract cannot work from
# this checkout.

echo "Monorepo deploys are not wired yet: the unified pnpm workspace has no
cloud-local lockfile, so the server-side 'pnpm install' step of
frameos-cloud-update cannot work from this checkout. Deploy from the
pre-merge private repo for now, or implement the standalone-bundle deploy
described in docs/deployment.md (\"Monorepo cutover\")." >&2
exit 1
