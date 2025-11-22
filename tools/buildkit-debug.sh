#!/usr/bin/env bash
# Quick sanity checks for the BuildKit daemon inside the FrameOS container.
set -euo pipefail

addr=${FRAMEOS_BUILDKIT_ADDR:-unix:///tmp/buildkit/buildkitd.sock}
socket_path=${addr#unix://}

cat <<EOT
BuildKit debug helper
=====================
Using FRAMEOS_BUILDKIT_ADDR=${addr}
Socket path: ${socket_path}
EOT

if command -v buildkitd >/dev/null 2>&1; then
  echo "buildkitd binary found: $(command -v buildkitd)"
else
  echo "buildkitd is missing from PATH" >&2
fi

if command -v buildctl >/dev/null 2>&1; then
  echo "buildctl binary found: $(command -v buildctl)"
else
  echo "buildctl is missing from PATH" >&2
fi

echo
echo "1) Check for a running daemon"
if pgrep -fal "buildkitd .*${socket_path}"; then
  echo "✔ buildkitd process detected"
else
  echo "✘ buildkitd process not found"
fi

if [ -S "${socket_path}" ]; then
  echo "✔ Socket exists at ${socket_path}"
else
  echo "✘ Socket missing at ${socket_path}"
fi

if [ -r /tmp/buildkit.log ]; then
  echo "Last 20 lines of /tmp/buildkit.log:"
  tail -n 20 /tmp/buildkit.log || true
else
  echo "No /tmp/buildkit.log present"
fi

echo
echo "2) Probe workers via buildctl"
if buildctl --addr "${addr}" debug workers; then
  echo "✔ buildctl can reach the daemon"
else
  echo "✘ buildctl could not reach the daemon"
fi

echo
echo "3) Show environment for backend cross-compile"
python - <<'PY'
import os
print("FRAMEOS_BUILDKIT_ADDR=", os.environ.get("FRAMEOS_BUILDKIT_ADDR"))
print("BUILDKIT_HOST=", os.environ.get("BUILDKIT_HOST"))
PY
