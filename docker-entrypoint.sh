#!/bin/bash
set -e  # exit as soon as a command fails

# 1. Conditionally start local Redis only if REDIS_URL is not set.
if [ -z "$REDIS_URL" ]; then
  # Redis holds state the SQLite database does not: a virtual frame's scene
  # state and active scene, every frame's last known scene, the deploy and
  # task queues. Until 2026-10-12 it ran with no persistence at all, so a
  # container restart emptied it and virtual frames came back on their scene
  # defaults. Append-only, fsynced every second, on the data volume next to
  # the database (/data on a Home Assistant add-on). REDIS_DATA_DIR overrides.
  if [ -z "$REDIS_DATA_DIR" ]; then
    if [ -n "$HASSIO_TOKEN" ] && [ -d /data ]; then
      REDIS_DATA_DIR=/data/redis
    else
      REDIS_DATA_DIR=/app/db/redis
    fi
  fi
  mkdir -p "$REDIS_DATA_DIR"
  echo "🥕 Starting local Redis (no REDIS_URL detected), data in $REDIS_DATA_DIR."
  redis-server --daemonize yes --dir "$REDIS_DATA_DIR" --appendonly yes --appendfsync everysec
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
