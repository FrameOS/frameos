#!/bin/bash
set -e  # exit as soon as a command fails

# 1. Conditionally start local Redis only if REDIS_URL is not set.
if [ -z "$REDIS_URL" ]; then
  echo "🥕 Starting local Redis (no REDIS_URL detected)."
  redis-server --daemonize yes
else
  echo "REDIS_URL is set ($REDIS_URL). Skipping local Redis."
fi

# 2. Keep the ESP32 firmware build dir and compiler cache off the container's
# writable layer. A cold ESP-IDF build is ~1300 objects and ~275MB of output,
# so restarting the container between builds otherwise means every build is a
# from-scratch build. /data is the add-on's persistent map; the db volume is
# what docker-compose persists.
if [ -z "$FRAMEOS_EMBEDDED_BUILD_ROOT" ]; then
  if [ -n "$HASSIO_TOKEN" ] && [ -d /data ]; then
    FRAMEOS_EMBEDDED_BUILD_ROOT=/data/embedded-build
  else
    FRAMEOS_EMBEDDED_BUILD_ROOT=/app/db/embedded-build
  fi
fi
export FRAMEOS_EMBEDDED_BUILD_ROOT
export CCACHE_DIR="${CCACHE_DIR:-$FRAMEOS_EMBEDDED_BUILD_ROOT/ccache}"
export CCACHE_MAXSIZE="${CCACHE_MAXSIZE:-2G}"
mkdir -p "$FRAMEOS_EMBEDDED_BUILD_ROOT" "$CCACHE_DIR" || true

cd backend
# Activate your virtual environment
source .venv/bin/activate

echo "🏃‍♂️ Running migrations"
python -m alembic upgrade head

echo "⛵️ Launching Arq worker"
arq app.tasks.worker.WorkerSettings &

# 3. Check for Home Assistant Ingress
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
