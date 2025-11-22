#!/bin/bash
set -e  # exit as soon as a command fails

BUILDKIT_SOCKET=${FRAMEOS_BUILDKIT_ADDR:-/tmp/buildkit/buildkitd.sock}
if ! pgrep -f "buildkitd .*${BUILDKIT_SOCKET}" >/dev/null 2>&1; then
  echo "🔧 Starting rootless BuildKit daemon at ${BUILDKIT_SOCKET}"
  mkdir -p "$(dirname "${BUILDKIT_SOCKET}")" /var/lib/buildkit
  buildkitd --oci-worker-no-process-sandbox --root /var/lib/buildkit --addr "unix://${BUILDKIT_SOCKET}" >/tmp/buildkit.log 2>&1 &
  export FRAMEOS_BUILDKIT_ADDR="unix://${BUILDKIT_SOCKET}"
else
  echo "🔧 BuildKit daemon already running at ${BUILDKIT_SOCKET}"
fi

# 1. Conditionally start local Redis only if REDIS_URL is not set.
if [ -z "$REDIS_URL" ]; then
  echo "🥕 Starting local Redis (no REDIS_URL detected)."
  redis-server --daemonize yes
else
  echo "REDIS_URL is set ($REDIS_URL). Skipping local Redis."
fi

cd backend
# Activate your virtual environment
source .venv/bin/activate

echo "🏃‍♂️ Running migrations"
python -m alembic upgrade head

echo "⛵️ Launching Arq worker"
arq app.tasks.worker.WorkerSettings &

# 2. Check for Home Assistant Ingress
if [ -n "$HASSIO_TOKEN" ]; then
  echo "🔦 Detected HASSIO_TOKEN -> Running two uvicorns: public (8989) + ingress (8990)"

  # Public server on port 8989 in background
  echo "🔓 Launching HASSIO_RUN_MODE=public uvicorn on port 8989"
  HASSIO_RUN_MODE="public" uvicorn app.fastapi:app \
      --host 0.0.0.0 \
      --port 8989 &

  # Ingress server on port 8990 in foreground
  echo "🔒 Launching HASSIO_RUN_MODE=ingress uvicorn on port 8990"
  HASSIO_RUN_MODE="ingress" uvicorn app.fastapi:app \
      --host 0.0.0.0 \
      --port 8990

else
  # No Ingress: single server on port 8989
  echo "🔦 Launching uvicorn on port 8989"
  uvicorn app.fastapi:app \
      --host 0.0.0.0 \
      --port 8989
fi
