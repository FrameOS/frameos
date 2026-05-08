#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE=".env.docker.local"
IMAGE_NAME="frameos"
CONTAINER_NAME="frameos"
docker_pid=""

mkdir -p db

# Persist a stable local secret so sessions survive container recreation.
if ! grep -q '^SECRET_KEY=' "$ENV_FILE" 2>/dev/null; then
  SECRET_KEY="$(openssl rand -base64 32 | tr -d '\n')"
  printf 'SECRET_KEY=%s\n' "$SECRET_KEY" > "$ENV_FILE"
fi

docker build -t "$IMAGE_NAME" .

if docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  docker rm -f "$CONTAINER_NAME"
fi

cleanup() {
  if [ -n "$docker_pid" ]; then
    kill "$docker_pid" >/dev/null 2>&1 || true
  fi

  if docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi
}

handle_signal() {
  cleanup
  exit 130
}

trap handle_signal INT TERM

docker run \
  -p 8989:8989 \
  -v ./db:/app/db \
  --name "$CONTAINER_NAME" \
  --restart always \
  --env-file "$ENV_FILE" \
  "$IMAGE_NAME" &
docker_pid=$!

set +e
wait "$docker_pid"
exit_code=$?
set -e

cleanup
exit "$exit_code"
