from __future__ import annotations

import re
from pathlib import Path

# ESP-IDF keeps five shutdown handlers in all (esp_system.c
# SHUTDOWN_HANDLERS_NO), and its timekeeping and the Wi-Fi driver take two.
# FrameOS's modules once registered six of their own: on a frame with no
# network saved, the Wi-Fi driver came up late (the frame page's scan), found
# the five taken, and esp_netif_create_default_wifi_sta aborted the board
# (a reTerminal Sticky, 2026-11-25). FrameOS takes one of the five
# (main/fos_restart.c) and its modules add hooks there.

REPO_ROOT = Path(__file__).resolve().parents[4]
ESP32_DIR = REPO_ROOT / "embedded" / "esp32"
RESTART = ESP32_DIR / "main" / "fos_restart.c"


def _firmware_sources() -> list[Path]:
    sources = sorted((ESP32_DIR / "main").glob("*.c"))
    for component in ("frameos_display", "frameos_nim"):
        sources += sorted((ESP32_DIR / "components" / component).rglob("*.c"))
    return [path for path in sources if "tests" not in path.parts and "nimcache" not in path.parts]


def test_frameos_takes_one_shutdown_handler():
    takers = [
        path.relative_to(ESP32_DIR).as_posix()
        for path in _firmware_sources()
        if "esp_register_shutdown_handler(" in path.read_text(errors="replace")
    ]
    assert takers == ["main/fos_restart.c"], (
        "only main/fos_restart.c registers an ESP-IDF shutdown handler; add a hook with fos_on_restart() "
        f"instead (found in {takers})"
    )


def test_restart_hooks_run_newest_first():
    source = RESTART.read_text()
    assert "esp_register_shutdown_handler(run_hooks)" in source
    assert re.search(r"for \(int i = s_count - 1; i >= 0; i--\) s_hooks\[i\]\(\);", source)
