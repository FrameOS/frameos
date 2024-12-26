#!/bin/bash

set -e # exit as soon as a command fails

echo "🥕 Starting Redis"
redis-server --daemonize yes

cd backend
source .venv/bin/activate 

echo "🏃‍♂️ Running migrations"
python -m alembic upgrade head

echo "⛵️ Launching Arq"
arq app.tasks.worker.WorkerSettings &

echo "🔦 Launching FastAPI"
uvicorn app.fastapi:app --host 0.0.0.0 --port 8989 --reload
