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

# 2. The provider sidecar: FrameOS Cloud's frame hub, which frames enrolled
#    with this backend dial through /api/frames/ws (docs/convergence-todo.md
#    item 7). It keeps its queue, its frames and what they report in a
#    PostgreSQL of its own, with the cloud's schema; both live in the data
#    volume next to the backend's database. FRAMEOS_PROVIDER_SIDECAR=0 turns
#    the pair off (enrolled frames then cannot connect).
if [ "${FRAMEOS_PROVIDER_SIDECAR:-1}" != "0" ] && [ -f /app/provider/index.cjs ]; then
  if [ -z "$FRAMEOS_PROVIDER_DATA_DIR" ]; then
    if [ -n "$HASSIO_TOKEN" ] && [ -d /data ]; then
      FRAMEOS_PROVIDER_DATA_DIR=/data/provider
    else
      FRAMEOS_PROVIDER_DATA_DIR=/app/db/provider
    fi
  fi
  mkdir -p "$FRAMEOS_PROVIDER_DATA_DIR/objects"
  chmod 700 "$FRAMEOS_PROVIDER_DATA_DIR"
  # Generated once and kept with the data: the database password, the hub's
  # session secret and the secret the backend presents to the bridge.
  provider_secrets="$FRAMEOS_PROVIDER_DATA_DIR/sidecar.env"
  if [ ! -s "$provider_secrets" ]; then
    (
      umask 077
      new_secret() { python3 -c 'import secrets; print(secrets.token_urlsafe(32))'; }
      {
        echo "PROVIDER_PG_PASSWORD=$(new_secret)"
        echo "PROVIDER_SESSION_SECRET=$(new_secret)"
        echo "FRAMEOS_PROVIDER_BRIDGE_SECRET=$(new_secret)"
      } > "$provider_secrets"
    )
  fi
  set -a
  # shellcheck disable=SC1090
  . "$provider_secrets"
  set +a

  pg_bin="$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -n 1)"
  pg_data="$FRAMEOS_PROVIDER_DATA_DIR/postgres"
  if [ ! -s "$pg_data/PG_VERSION" ]; then
    echo "🐘 Creating the provider sidecar's PostgreSQL in $pg_data"
    mkdir -p "$pg_data"
    chown -R postgres:postgres "$pg_data"
    pg_pwfile="$(mktemp)"
    echo "$PROVIDER_PG_PASSWORD" > "$pg_pwfile"
    chown postgres "$pg_pwfile"
    runuser -u postgres -- "$pg_bin/initdb" -D "$pg_data" -U frameos --pwfile="$pg_pwfile" \
      --auth=scram-sha-256 -E UTF8 > /dev/null
    rm -f "$pg_pwfile"
  fi
  chown -R postgres:postgres "$pg_data"
  # A fresh container runs no postgres: a lock file is the last one's.
  rm -f "$pg_data/postmaster.pid"
  echo "🐘 Starting the provider sidecar's PostgreSQL (127.0.0.1:5433)"
  # Sized for a Raspberry Pi running Home Assistant: one hub and one bridge
  # connect, and the tables are a frame queue and a log buffer.
  runuser -u postgres -- "$pg_bin/pg_ctl" -D "$pg_data" -l "$FRAMEOS_PROVIDER_DATA_DIR/postgres.log" -w \
    -o "-c listen_addresses=127.0.0.1 -p 5433 -k /tmp -c shared_buffers=16MB -c max_connections=30 -c work_mem=2MB" \
    start > /dev/null
  if ! PGPASSWORD="$PROVIDER_PG_PASSWORD" "$pg_bin/psql" -h 127.0.0.1 -p 5433 -U frameos -d postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname = 'frameos_provider'" | grep -q 1; then
    PGPASSWORD="$PROVIDER_PG_PASSWORD" "$pg_bin/createdb" -h 127.0.0.1 -p 5433 -U frameos frameos_provider
  fi

  echo "📡 Launching the provider sidecar (frame hub 127.0.0.1:3100, bridge 127.0.0.1:3101)"
  # The hub's own DATABASE_URL, never the backend's (set inline, not exported).
  DATABASE_URL="postgres://frameos:${PROVIDER_PG_PASSWORD}@127.0.0.1:5433/frameos_provider" \
  SESSION_SECRET="$PROVIDER_SESSION_SECRET" \
  FRAMEOS_OBJECT_STORE_DIR="$FRAMEOS_PROVIDER_DATA_DIR/objects" \
  FRAME_HUB_PORT=3100 \
  FRAMEOS_PROVIDER_BRIDGE_PORT=3101 \
  RATE_LIMIT_TRUSTED_PROXY_COUNT=1 \
  FRAMEOS_CLOUD_MAX_FRAME_LOG_MB=256 \
  NODE_ENV=production \
    node /app/provider/index.cjs &
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
