#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Builds apps/auth-web locally (Next.js standalone output) and streams a
# self-contained bundle into /usr/local/bin/frameos-cloud-update on the
# server, which runs migrations, swaps /opt/frameos-cloud (keeping
# /opt/frameos-cloud.previous as rollback), and restarts
# frameos-cloud-auth-web.service. The server needs no pnpm or build step.
# See docs/deployment.md.
#
# Any ref can be deployed, not just main: `pnpm deploy:prod -- <ref>` builds
# THAT ref rather than whatever is checked out. Shipping a branch to
# production is a normal thing to do here (the cloud is the only place some
# frame-facing work can be exercised at all), so the point is to make it
# deliberate and legible rather than to prevent it — the ref is named on the
# command line, announced before the build, and recorded on the server.

usage() {
  cat >&2 <<'USAGE'
Usage: pnpm deploy:prod [-- <ref>]

  <ref>   Branch, tag or commit to deploy. A plain branch name resolves
          against the remote first, so `-- my-branch` deploys what is
          pushed, not a stale local copy of it. Omitted, the current
          checkout is deployed (the long-standing behaviour).

The ref must exist on the remote either way: production has to be a state
someone else can check out, roll forward from, or revert to.

Environment: FRAMEOS_CLOUD_DEPLOY_HOST, FRAMEOS_CLOUD_DEPLOY_SSH_KEY,
FRAMEOS_CLOUD_DEPLOY_REMOTE (default origin),
FRAMEOS_CLOUD_DEPLOY_DEFAULT_BRANCH (default main),
FRAMEOS_CLOUD_DEPLOY_CHECK_URL, FRAMEOS_ACCOUNT_DEPLOY_CHECK_URL,
FRAMEOS_SCENES_DEPLOY_CHECK_URL.
USAGE
}

deploy_ref=""
while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --)
      shift
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage
      exit 2
      ;;
    *)
      if [ -n "$deploy_ref" ]; then
        echo "Deploy one ref at a time (got '$deploy_ref' and '$1')." >&2
        exit 2
      fi
      deploy_ref="$1"
      shift
      ;;
  esac
done

deploy_host="${FRAMEOS_CLOUD_DEPLOY_HOST:-root@167.233.35.240}"
ssh_key="${FRAMEOS_CLOUD_DEPLOY_SSH_KEY:-$HOME/.ssh/hetzner}"
remote="${FRAMEOS_CLOUD_DEPLOY_REMOTE:-origin}"
default_branch="${FRAMEOS_CLOUD_DEPLOY_DEFAULT_BRANCH:-main}"
cloud_check_url="${FRAMEOS_CLOUD_DEPLOY_CHECK_URL:-https://cloud.frameos.net/login}"
account_check_url="${FRAMEOS_ACCOUNT_DEPLOY_CHECK_URL:-https://account.frameos.net/}"
scenes_check_url="${FRAMEOS_SCENES_DEPLOY_CHECK_URL:-https://scenes.frameos.net/}"

# Checked before anything is fetched or checked out: switching refs under a
# dirty tree would either fail halfway or quietly carry uncommitted work into
# the build.
if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree is dirty; commit or stash before deploying." >&2
  exit 1
fi

# Where to come back to. A branch name when on one, otherwise the commit —
# restoring a detached HEAD to its branch would be a change the caller did
# not ask for.
original_ref="$(git symbolic-ref --quiet --short HEAD || git rev-parse HEAD)"
checkout_switched=false
restore_checkout() {
  if [ "$checkout_switched" = true ]; then
    echo "Restoring $original_ref"
    git checkout --quiet "$original_ref"
  fi
}

# Remote-tracking refs have to be current for both the resolution below and
# the "is it pushed" check; the deploy needs the network regardless.
echo "Fetching $remote"
git fetch --quiet "$remote"

if [ -n "$deploy_ref" ]; then
  # The remote wins over a same-named local branch. "Deploy my-branch" means
  # the branch as everyone else can see it — deploying a local commit that
  # merely shares the name is exactly the surprise this avoids.
  if git rev-parse --verify --quiet "refs/remotes/$remote/$deploy_ref^{commit}" >/dev/null; then
    target_sha="$(git rev-parse "refs/remotes/$remote/$deploy_ref^{commit}")"
    echo "Resolved '$deploy_ref' to $remote/$deploy_ref ($target_sha)"
  elif git rev-parse --verify --quiet "$deploy_ref^{commit}" >/dev/null; then
    target_sha="$(git rev-parse "$deploy_ref^{commit}")"
    echo "Resolved '$deploy_ref' to $target_sha (no $remote/$deploy_ref branch)"
  else
    echo "Cannot resolve '$deploy_ref' to a commit; is it fetched and spelled right?" >&2
    exit 1
  fi

  if [ "$target_sha" != "$(git rev-parse HEAD)" ]; then
    trap restore_checkout EXIT
    checkout_switched=true
    # Detached: the build only needs the tree, and moving a local branch (or
    # creating one) would leave the caller's repo rearranged after a deploy.
    git checkout --quiet --detach "$target_sha"
  fi
fi

head_sha="$(git rev-parse HEAD)"

# Reachability from any branch on the remote, rather than the old
# `@{upstream}` test: a detached HEAD and a branch checked out without
# tracking configured both have no upstream, and both are perfectly
# deployable once the commit is pushed.
if ! git branch --remotes --contains "$head_sha" --format='%(refname)' 2>/dev/null |
  grep -q "^refs/remotes/$remote/"; then
  echo "HEAD ($head_sha) is not on any $remote branch; push before deploying." >&2
  exit 1
fi

# What is about to be live, named as a person would name it. Prefer the ref
# that was asked for; fall back to the branch that is checked out.
if [ -n "$deploy_ref" ]; then
  release_ref="$deploy_ref"
elif [ "$original_ref" != "$head_sha" ]; then
  release_ref="$original_ref"
else
  release_ref="(detached $head_sha)"
fi

default_sha="$(git rev-parse --verify --quiet "refs/remotes/$remote/$default_branch^{commit}" || true)"
if [ "$head_sha" != "$default_sha" ]; then
  # Loud on purpose. Production running something other than the default
  # branch is fine, but it must never be a thing you find out later.
  echo
  echo "  =============================================================="
  echo "   Deploying a NON-DEFAULT ref to production"
  echo "     ref:    $release_ref"
  echo "     commit: $head_sha"
  echo "     ($remote/$default_branch is ${default_sha:-unknown})"
  echo "   Redeploy $default_branch when you are done with it."
  echo "  =============================================================="
  echo
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
# One trap for both jobs: a second `trap ... EXIT` would REPLACE the checkout
# restore installed above, leaving the caller on a detached HEAD after every
# branch deploy.
cleanup() {
  rm -rf "$stage"
  restore_checkout
}
trap cleanup EXIT

echo "Assembling the release bundle"
# The standalone output mirrors the monorepo layout:
#   node_modules/ and cloud/apps/auth-web/{server.js,.next,node_modules}.
# cp -a keeps the relative symlinks inside node_modules/.pnpm intact.
cp -a "$standalone_dir/." "$stage/"
# The trace may have pre-created these directories with the few files the
# server reads at runtime, so copy *contents* — `cp -a src dst` would nest
# src inside an existing dst (public/public/) and every asset would 404.
mkdir -p "$stage/cloud/$app_dir/.next/static" "$stage/cloud/$app_dir/public" "$stage/cloud/$app_dir/scripts"
cp -a "$app_dir/.next/static/." "$stage/cloud/$app_dir/.next/static/"
cp -a "$app_dir/public/." "$stage/cloud/$app_dir/public/"
cp -a "$app_dir/scripts/." "$stage/cloud/$app_dir/scripts/"
# Frame hub: the single-file bundle is all the service needs at runtime.
mkdir -p "$stage/cloud/$hub_dir"
cp -a "$hub_dir/dist" "$stage/cloud/$hub_dir/dist"
mkdir -p "$stage/cloud/packages/db"
cp -a packages/db/drizzle "$stage/cloud/packages/db/drizzle"
mkdir -p "$stage/cloud/scripts"
cp -a scripts/db-migrate.sh scripts/db-cleanup.sh "$stage/cloud/scripts/"
# RELEASE stays exactly one bare SHA — frameos-cloud-update on the server
# reads it, and this script cannot see that code to check what it tolerates.
# The human-readable detail goes next to it instead, so `cat RELEASE_REF` on
# the box answers "which branch is prod on?" without anyone having to resolve
# a SHA against a repo they may not have.
echo "$head_sha" > "$stage/RELEASE"
cat > "$stage/RELEASE_REF" <<RELEASE_REF
ref $release_ref
commit $head_sha
deployed_at $(date -u +%Y-%m-%dT%H:%M:%SZ)
deployed_by ${USER:-unknown}
RELEASE_REF

echo "Deploying ${release_ref} (${head_sha}) to ${deploy_host}"
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
    echo "Deployed ${release_ref} — ${head_sha} (${check_summary})"
    exit 0
  fi
  echo "Attempt ${attempt}: ${check_summary}; retrying in 5s"
  sleep 5
done

echo "Deploy finished but a public URL stayed unhealthy (${check_summary}); investigate (rollback: move /opt/frameos-cloud.previous back and restart)." >&2
exit 1
