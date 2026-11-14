#!/usr/bin/env bash
# Prints the tag of the image the ESP32 CI job builds firmware in: the
# Dockerfile's `esp-idf-toolchain` stage (ESP-IDF for both chips and QEMU,
# nothing of this repository), named after a hash of the Dockerfile up to the
# first stage that copies sources in. A tag can therefore only name an image
# built from exactly these toolchain lines.
#
# The job runs ci_build_image.sh in it with the checkout, Nim and the nimble
# packages mounted from the runner (.github/workflows/e2e-docker.yml), instead
# of building the `esp32-ci` target, which first rebuilds the app-builder
# stage (pnpm install, the wasm runtime, the frontend: four minutes of a CI
# run spent on things the firmware never reads). The runner pool's VM image
# carries main's toolchain image under this tag
# (tools/gha-runners/bin/gha-image-warm.sh); anywhere else, or after a change
# to these lines, the job builds it from the esp32-ci registry layer cache.
set -euo pipefail

dockerfile="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/Dockerfile"
python3 - "$dockerfile" <<'PY'
import hashlib
import re
import sys

lines = []
for line in open(sys.argv[1], encoding="utf-8"):
    if re.match(r"FROM\s+\S+\s+AS\s+app-builder\s*$", line):
        break
    lines.append(line)
print("frameos-esp32-toolchain:" + hashlib.sha256("".join(lines).encode()).hexdigest()[:16])
PY
