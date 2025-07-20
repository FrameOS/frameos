#!/usr/bin/env bash
# Collect all files to paste to ChatGPT o1
OUTPUT="gpt.txt"

# Start fresh
> "$OUTPUT"

echo "" >> "$OUTPUT"

# Define the patterns you want to collect files from:
patterns=(
    # "docker-entrypoint.sh"
    "Dockerfile"
    # "backend/app/*.py"
    # "backend/app/schemas/*.py"
    # "backend/app/api/agent.py"
    "backend/app/api/frames.py"
    "backend/app/ws/*"
    # "backend/app/api/tests/*.py"
    # "backend/app/api/tests/test_frames.py"
    # "backend/app/api/tests/test_settings.py"
    # "backend/app/models/agent.py"
    "backend/app/models/frame.py"
    # "backend/app/models/assets.py"
    # "backend/app/utils/ssh_utils.py"
    # "backend/app/utils/local_exec.py"
    "backend/app/utils/remote_exec.py"
    # "backend/app/tasks/*.py"
    "backend/app/tasks/deploy_agent.py"
    "backend/app/tasks/deploy_frame.py"
    "backend/app/tasks/build_sd_card_image.py"
    # "backend/app/models/tests/*.py"
    # "frontend/src/urls.ts"
    # "frontend/src/main.tsx"
    # "frontend/src/types.tsx"
    # "frontend/src/scenes/App.tsx"
    # "frontend/src/scenes/scenes.tsx"
    # "frontend/src/scenes/sceneLogic.tsx"
    # "frameos/src/apps/*/*/config.json"
    # "frameos/frame.json"
    "frameos/frameos.nimble"
    # "frameos/frameos.service"
    "frameos/flake.nix"
    "frameos/flake.lock"
    "frameos/Makefile"
    "frameos/agent/*"
    "frameos/agent/src/*"
    # "frameos/src/frameos.nim"
    # "frameos/src/frameos/frameos.nim"
    # "frameos/src/frameos/portal.nim"
    # "frameos/src/frameos/server.nim"
    # "frameos/src/frameos/types.nim"
    # "frameos/src/frameos/config.nim"
    # "frameos/src/frameos/types.nim"
    # "frameos/src/frameos/*.nim"
    # "frameos/src/frameos/utils/*.nim"
    # "frameos/src/scenes/*.nim"
    # "frameos/src/drivers/drivers.nim"
    # "frameos/src/apps/*/*/*"
)

for pattern in "${patterns[@]}"; do
    for f in $pattern; do
        # Check if the file actually exists and is a regular file
        if [ -f "$f" ]; then
            echo "$f" >> "$OUTPUT"
            echo "-------------" >> "$OUTPUT"
            cat "$f" >> "$OUTPUT"
            echo "-------------" >> "$OUTPUT"
        fi
    done
done

