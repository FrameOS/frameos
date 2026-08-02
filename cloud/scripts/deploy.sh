#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Builds apps/auth-web locally (Next.js standalone output) and streams a
# self-contained bundle into /usr/local/bin/frameos-cloud-update on the
# server, which runs migrations, swaps /opt/frameos-cloud (keeping
# /opt/frameos-cloud.previous as rollback), and restarts
# frameos-cloud-auth-web.service. The server needs no pnpm or build step.
# See docs/deployment.md.

deploy_host="${FRAMEOS_CLOUD_DEPLOY_HOST:-root@167.233.35.240}"
ssh_key="${FRAMEOS_CLOUD_DEPLOY_SSH_KEY:-$HOME/.ssh/hetzner}"
cloud_check_url="${FRAMEOS_CLOUD_DEPLOY_CHECK_URL:-https://cloud.frameos.net/login}"
account_check_url="${FRAMEOS_ACCOUNT_DEPLOY_CHECK_URL:-https://account.frameos.net/}"
scenes_check_url="${FRAMEOS_SCENES_DEPLOY_CHECK_URL:-https://scenes.frameos.net/}"

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree is dirty; commit or stash before deploying." >&2
  exit 1
fi

head_sha="$(git rev-parse HEAD)"
if ! git merge-base --is-ancestor "$head_sha" "@{upstream}" 2>/dev/null; then
  echo "HEAD ($head_sha) is not pushed to its upstream; push before deploying." >&2
  exit 1
fi

echo "Installing dependencies and building the standalone bundle"
(cd .. && pnpm install --frozen-lockfile)
pnpm build

app_dir="apps/auth-web"
standalone_dir="$app_dir/.next/standalone"
if [ ! -f "$standalone_dir/cloud/$app_dir/server.js" ]; then
  echo "Standalone server missing at $standalone_dir/cloud/$app_dir/server.js; is output: \"standalone\" set in next.config.ts?" >&2
  exit 1
fi

# Second service: the frame hub is an esbuild bundle, self-contained in one
# file (see docs/deployment.md "Frame hub"). `pnpm build` above built it via
# the turbo filter in cloud/package.json.
hub_dir="apps/frame-hub"
if [ ! -f "$hub_dir/dist/index.cjs" ]; then
  echo "Frame hub bundle missing at $hub_dir/dist/index.cjs; did \`pnpm build\` run @frameos-cloud/frame-hub#build?" >&2
  exit 1
fi

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

echo "Assembling the release bundle"
# The standalone output mirrors the monorepo layout:
#   node_modules/ and cloud/apps/auth-web/{server.js,.next,node_modules}.
# cp -a keeps the relative symlinks inside node_modules/.pnpm intact.
cp -a "$standalone_dir/." "$stage/"
cp -a "$app_dir/.next/static" "$stage/cloud/$app_dir/.next/static"
cp -a "$app_dir/public" "$stage/cloud/$app_dir/public"
cp -a "$app_dir/scripts" "$stage/cloud/$app_dir/scripts"
# Frame hub: the single-file bundle is all the service needs at runtime.
mkdir -p "$stage/cloud/$hub_dir"
cp -a "$hub_dir/dist" "$stage/cloud/$hub_dir/dist"
mkdir -p "$stage/cloud/packages/db"
cp -a packages/db/drizzle "$stage/cloud/packages/db/drizzle"
mkdir -p "$stage/cloud/scripts"
cp -a scripts/db-migrate.sh scripts/db-cleanup.sh "$stage/cloud/scripts/"
echo "$head_sha" > "$stage/RELEASE"

echo "Deploying ${head_sha} to ${deploy_host}"
tar -C "$stage" -cf - . |
  ssh -i "$ssh_key" "$deploy_host" frameos-cloud-update --archive -

echo "Verifying service and public URLs"
ssh -i "$ssh_key" "$deploy_host" systemctl is-active frameos-cloud-auth-web.service

# Restart the frame hub from the freshly swapped release. Tolerate the unit
# not being installed yet on a host that predates the hub (unit file content:
# docs/deployment.md "Frame hub").
ssh -i "$ssh_key" "$deploy_host" '
  if systemctl cat frameos-cloud-frame-hub.service >/dev/null 2>&1; then
    systemctl restart frameos-cloud-frame-hub.service &&
    systemctl is-active frameos-cloud-frame-hub.service
  else
    echo "frameos-cloud-frame-hub.service not installed; see cloud/docs/deployment.md"
  fi
'

# The service restart races the first request; retry briefly before alarming.
for attempt in 1 2 3 4 5 6; do
  checks_ok=true
  check_summary=""
  for check_url in "$cloud_check_url" "$account_check_url" "$scenes_check_url"; do
    status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$check_url")"
    check_summary="${check_summary}${check_summary:+, }${check_url} -> ${status}"
    case "$status" in
      2* | 3*) ;;
      *) checks_ok=false ;;
    esac
  done
  if [ "$checks_ok" = true ]; then
    echo "Deployed ${head_sha} (${check_summary})"
    exit 0
  fi
  echo "Attempt ${attempt}: ${check_summary}; retrying in 5s"
  sleep 5
done

echo "Deploy finished but a public URL stayed unhealthy (${check_summary}); investigate (rollback: move /opt/frameos-cloud.previous back and restart)." >&2
exit 1
