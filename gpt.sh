#!/usr/bin/env bash
# Collect all files to paste to ChatGPT o1
OUTPUT="gpt.txt"

# Start fresh
> "$OUTPUT"

echo "" >> "$OUTPUT"

# Define the patterns you want to collect files from:
patterns=(
    # "docker-entrypoint.sh"
    # "Dockerfile"
    # "backend/app/*.py"
    # "backend/app/schemas/*.py"
    # "backend/app/api/*.py"
    # "backend/app/api/tests/*.py"
    # "backend/app/api/tests/test_frames.py"
    # "backend/app/api/tests/test_settings.py"
    # "backend/app/models/*.py"
    # "backend/app/tasks/*.py"
    # "backend/app/models/tests/*.py"
    # "frontend/src/urls.ts"
    # "frontend/src/main.tsx"
    # "frontend/src/types.tsx"
    # "frontend/src/scenes/App.tsx"
    # "frontend/src/scenes/scenes.tsx"
    # "frontend/src/scenes/sceneLogic.tsx"
    # "frameos/src/apps/*/*/config.json"
    "frameos/src/frameos.nim"
    "frameos/src/frameos/*.nim"
    "frameos/src/frameos/utils/*.nim"
    "frameos/src/frameos/tests/*.nim"

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

