#!/usr/bin/env bash

# Start Redis
redis-server --daemonize yes

# Apply database migrations
cd backend
source .venv/bin/activate
flask db upgrade

# Start Huey task queue
echo "Starting Huey"
huey_consumer.py app.huey.huey --worker-type=greenlet --workers=10 --flush-locks &

# Start the application
echo "Starting FastAPI"
env/bin/uvicorn app.fastapi:app --host 0.0.0.0 --port 8989 --reload
