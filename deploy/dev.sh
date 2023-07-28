#!/bin/bash
# set -e
set -u
set -o pipefail

#HOST=pi@10.4.232.30   # pimoroni 5
HOST=pi@10.4.227.134   # pimoroni 7
FOLDER=/home/pi/frameos
SERVICE_NAME="frameos"

# Copy frameos to host
echo "[${HOST}] 🔄 Copying frameos to host..."
SYNC_OUTPUT=$(rsync -av -e ssh --exclude="env" ./frameos "${HOST}": 2>&1)
if [[ $? -ne 0 ]]; then
    echo "[${HOST}] 🛑 Error copying files: ${SYNC_OUTPUT}"
fi

# Try to restart the service
echo "[${HOST}] 🔄 Updating requirements"
ssh "${HOST}" "cd ${FOLDER} && python3 -m pip install -r ${FOLDER}/requirements.txt"
echo "[${HOST}] 🔄 Stopping service"
ssh "${HOST}" "sudo systemctl stop ${SERVICE_NAME}.service 2>&1"
echo "[${HOST}] 🔄 Running dev script"
ssh "${HOST}" python3 ${FOLDER}/frame.py

