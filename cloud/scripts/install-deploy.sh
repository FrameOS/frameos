#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Copies cloud/ops/deploy to the production host and runs its installer, which
# converts the host to the zero-downtime blue/green layout. Rerun it with
# `--scripts-only` whenever cloud/ops/deploy/frameos-cloud-update or the CI
# key's forced-command wrapper changes: a deploy reports that the box is
# behind but never installs root-run scripts out of the archive.
#
# The installer itself is careful — it keeps traffic on the running process
# until the new instance is healthy on the other port — but it does rewrite
# nginx vhosts and swap a systemd unit, so read cloud/docs/deployment.md and
# run it with --dry-run first:
#
#   pnpm deploy:install -- --dry-run
#   pnpm deploy:install

deploy_host="${FRAMEOS_CLOUD_DEPLOY_HOST:-root@167.233.35.240}"
ssh_key="${FRAMEOS_CLOUD_DEPLOY_SSH_KEY:-$HOME/.ssh/hetzner}"
remote_dir="/root/frameos-cloud-deploy"

args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --) shift ;;
    *)
      args+=("$1")
      shift
      ;;
  esac
done

echo "Copying ops/deploy to ${deploy_host}:${remote_dir}"
ssh -i "$ssh_key" "$deploy_host" "mkdir -p '$remote_dir'"
# The forced-command wrapper travels too: install.sh refreshes it where one
# is already installed (--scripts-only is the shape for "just the scripts").
scp -q -i "$ssh_key" ops/deploy/frameos-cloud-update ops/deploy/install.sh \
  ops/deploy/frameos-cloud-deploy-command \
  "ops/deploy/frameos-cloud-auth-web@.service" "$deploy_host:$remote_dir/"

echo "Running the installer on ${deploy_host}"
# -t so the installer's confirmation prompt reaches the terminal.
ssh -t -i "$ssh_key" "$deploy_host" \
  "chmod +x '$remote_dir/install.sh' '$remote_dir/frameos-cloud-update' && '$remote_dir/install.sh' ${args[*]:-}"
