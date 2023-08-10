#!/bin/bash

# TODO: reuse the service part from this old script

# set -e
set -u
set -o pipefail

#HOST=pi@10.4.232.30   # pimoroni 5
HOST=pi@10.4.227.134   # pimoroni 7
REMOTE_SERVICE_PATH="/etc/systemd/system/frameos.service"
REMOTE_EXEC_PATH="/usr/bin/python3 /home/pi/frameos/frame.py"
SERVICE_NAME="frameos"

# function to install
install_service() {
    SSH_OUTPUT=$(ssh -t "${HOST}" <<-EOF 2>&1 | tee /dev/fd/2
    echo '[Unit]
    Description=FrameOS

    [Service]
    ExecStart=${REMOTE_EXEC_PATH}
    Restart=always
    User=pi

    [Install]
    WantedBy=multi-user.target' | sudo tee ${REMOTE_SERVICE_PATH} > /dev/null
    sudo systemctl enable ${SERVICE_NAME}
    sudo systemctl start ${SERVICE_NAME}
    echo '[${HOST}] 🚀 Service FrameOS installed'
EOF
)
    if [[ $? -ne 0 ]]; then
        echo -e "\n\n[${HOST}] 🛑 Output from service restart attempt: ${SERVICE_RESTART_OUTPUT}"
        echo -e "\n\n[${HOST}] 🛑 SSH command output: ${SSH_OUTPUT}"
    fi
}

# Copy frameos to host
echo "[${HOST}] 🔄 Copying frameos to host..."
SYNC_OUTPUT=$(rsync -av -e ssh --exclude="env" ./frameos "${HOST}": 2>&1)
if [[ $? -ne 0 ]]; then
    echo "[${HOST}] 🛑 Error copying files: ${SYNC_OUTPUT}"
fi

echo "[${HOST}] 🔄 Updating requirements"
ssh "${HOST}" "cd /home/pi/frameos && python3 -m pip install -r /home/pi/frameos/requirements.txt"

# Try to restart the service
echo "[${HOST}] 🔄 Attempting to restart service..."
SERVICE_RESTART_OUTPUT=$(ssh "${HOST}" sudo systemctl restart ${SERVICE_NAME}.service 2>&1)

if [[ $? -eq 0 ]]; then
    echo "[${HOST}] ✅ FrameOS service updated successfully"
else
    echo -e "[${HOST}] 🟡 FrameOS service not installed or failed to restart"
    echo -e "[${HOST}] 🔄 Attempting to install and start service..."
    install_service
fi
