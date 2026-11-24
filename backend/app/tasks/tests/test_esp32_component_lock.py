from __future__ import annotations

import re
import subprocess
from pathlib import Path

# The firmware's one registry component (espressif/esp_websocket_client, the
# cloud socket) was named by a range ("^1.2.0") and resolved when an image was
# built: a signed release compiled whatever the registry served that day. The
# component manager's lock is committed now. It names the exact version and
# the hash of its files, the manager checks the download against it, and it
# is in the Docker build context too, where the release image is built from.

REPO_ROOT = Path(__file__).resolve().parents[4]
ESP32_DIR = REPO_ROOT / "embedded" / "esp32"
LOCK = ESP32_DIR / "dependencies.lock"
MANIFEST = ESP32_DIR / "main" / "idf_component.yml"


def _registry_dependencies() -> list[str]:
    names = re.findall(r"^  ([a-z0-9_]+/[a-z0-9_]+):", MANIFEST.read_text(), re.M)
    assert names, "no registry component in the manifest: this test and the lock can go"
    return names


def test_the_lock_is_in_the_tree_and_in_the_build_context():
    assert LOCK.is_file(), "embedded/esp32/dependencies.lock is not committed"
    assert "dependencies.lock" not in (ESP32_DIR / ".gitignore").read_text()
    assert "dependencies.lock" not in (REPO_ROOT / ".dockerignore").read_text()
    if (REPO_ROOT / ".git").exists():
        ignored = subprocess.run(["git", "check-ignore", "-q", str(LOCK)], cwd=REPO_ROOT)
        assert ignored.returncode != 0, "git still ignores the lock"


def test_every_registry_component_is_pinned_by_version_and_hash():
    lock = LOCK.read_text()
    for name in _registry_dependencies():
        block = re.search(rf"^  {re.escape(name)}:\n((?:    .*\n)+)", lock, re.M)
        assert block, f"{name} is not in the lock"
        assert re.search(r"^    component_hash: [0-9a-f]{64}$", block.group(1), re.M), f"{name}: no hash"
        assert re.search(r"^    version: \d+\.\d+\.\d+\S*$", block.group(1), re.M), f"{name}: no exact version"
        assert f"- {name}" in lock.split("direct_dependencies:")[1]
