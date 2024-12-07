#!/bin/bash

set -e # exit as soon as a command fails

echo "🥕 Starting Redis"
redis-server --daemonize yes

cd backend
source .venv/bin/activate 

echo "🏃‍♂️ Running migrations"
flask db upgrade

echo "🍿 Launching Huey"
huey_consumer.py app.huey.huey --worker-type=greenlet --workers=10 --flush-locks &

echo "🔦 Launching Flask"
python3 run.py
