#!/usr/bin/env bash

# Start Redis
redis-server --daemonize yes

# Apply database migrations
cd backend
source .venv/bin/activate
flask db upgrade

# Start Huey task queue
huey_consumer.py app.huey.huey --worker-type=greenlet --workers=10 --flush-locks &

# Start the Flask application
python3 run.py
