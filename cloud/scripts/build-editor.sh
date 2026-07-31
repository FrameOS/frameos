#!/usr/bin/env bash
# Builds the FrameOS editor bundle from this monorepo so the cloud can serve
# it: frontend/dist-editor (full frontend build) → frameos/editor/dist.
# apps/auth-web/scripts/copy-editor-assets.mjs then copies it into public/
# on the next dev/build, and scripts/deploy.sh ships it inside the deploy
# archive (the production server never builds it).
set -euo pipefail

cd "$(dirname "$0")/../.."

pnpm install --frozen-lockfile
pnpm --dir frontend run build
pnpm --dir frameos/editor run build

echo "Editor bundle built at frameos/editor/dist"
