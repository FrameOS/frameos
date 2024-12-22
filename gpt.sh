#!/usr/bin/env bash
# Collect all files to paste to ChatGPT o1
OUTPUT="gpt.txt"

# Start fresh
> "$OUTPUT"

echo "" > "$OUTPUT"

echo "\n\n" > "$OUTPUT"

# Define the patterns you want to collect files from:
patterns=(
    "backend/app/*.py"
    "backend/app/schemas/*.py"
    "backend/app/api/*.py"
    # "backend/app/api/tests/*.py"
    "backend/app/models/*.py"
    # "backend/app/models/tests/*.py"
    "frontend/src/types.tsx"
    # "frameos/src/apps/*/*/config.json"
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

