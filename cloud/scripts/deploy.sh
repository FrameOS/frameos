#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Deploys the current HEAD to production by streaming a git archive into
# /usr/local/bin/frameos-cloud-update on the server, which swaps
# /opt/frameos-cloud (keeping /opt/frameos-cloud.previous as rollback),
# installs dependencies, runs migrations, builds, and restarts
# frameos-cloud-auth-web.service. See docs/deployment.md.

deploy_host="${FRAMEOS_CLOUD_DEPLOY_HOST:?Set FRAMEOS_CLOUD_DEPLOY_HOST (user@host of the production server)}"
ssh_key="${FRAMEOS_CLOUD_DEPLOY_SSH_KEY:-}"
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

echo "Deploying ${head_sha} to ${deploy_host}"
# In the monorepo this directory is a subtree of the git root; archive only it.
prefix="$(git rev-parse --show-prefix)"
git archive --format=tar "HEAD${prefix:+:${prefix%/}}" |
  ssh ${ssh_key:+-i "$ssh_key"} "$deploy_host" frameos-cloud-update --archive -

echo "Verifying service and public URLs"
ssh ${ssh_key:+-i "$ssh_key"} "$deploy_host" systemctl is-active frameos-cloud-auth-web.service

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
