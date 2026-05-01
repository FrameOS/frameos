#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="$1"

install -d -m 0755 \
  "${TARGET_DIR}/etc/frameos" \
  "${TARGET_DIR}/var/lib/frameos/assets" \
  "${TARGET_DIR}/var/log"

if [[ -n "${FRAMEOS_RUNTIME_BINARY:-}" ]]; then
  if [[ ! -f "${FRAMEOS_RUNTIME_BINARY}" ]]; then
    echo "FRAMEOS_RUNTIME_BINARY does not exist: ${FRAMEOS_RUNTIME_BINARY}" >&2
    exit 1
  fi
  install -D -m 0755 "${FRAMEOS_RUNTIME_BINARY}" "${TARGET_DIR}/usr/bin/frameos"
else
  echo "No FRAMEOS_RUNTIME_BINARY set; /usr/bin/frameos will not be installed." >&2
fi
