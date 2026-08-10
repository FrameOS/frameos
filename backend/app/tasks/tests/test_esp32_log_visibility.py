from __future__ import annotations

import re
from pathlib import Path

import pytest

# Source invariants for ESP32 device logging.
#
# Every FrameOS sdkconfig profile sets CONFIG_LOG_DEFAULT_LEVEL_WARN, and
# ESP-IDF derives CONFIG_LOG_MAXIMUM_LEVEL from it — so ESP_LOGI/ESP_LOGD
# compile to NOTHING. That is not a runtime filter: esp_log_level_set() cannot
# bring those lines back, and raising the maximum level would compile every
# IDF INFO string into an image that has ~20% of its OTA slot left.
#
# The failure mode this guards against is silent and expensive: for the whole
# life of the ESP32 port, frameos_nim_log_hook() logged via ESP_LOGI, so the
# device put NO log line on the USB serial console. A frame that "sends no
# logs" could not be diagnosed over the cable at all, and the one line that
# says whether the cloud session was granted telemetry:logs was invisible too.
# Both are asserted below because both are last-resort diagnostics: they have
# to survive no network, no backend upload, and a missing cloud scope.

REPO_ROOT = Path(__file__).resolve().parents[4]
ESP32_DIR = REPO_ROOT / "embedded" / "esp32"
GLUE_C = ESP32_DIR / "components" / "frameos_nim" / "frameos_nim_glue.c"
CLOUD_C = ESP32_DIR / "main" / "fos_cloud.c"


def _strip_comments(source: str) -> str:
    """Drop C comments, so a comment explaining the ESP_LOGI ban does not read
    as a violation of it."""
    return re.sub(r"/\*.*?\*/|//[^\n]*", "", source, flags=re.DOTALL)


def _function_body(source: str, signature: str) -> str:
    """The brace-matched body of a top-level C function."""
    start = source.index(signature)
    open_brace = source.index("{", start)
    depth = 0
    for index in range(open_brace, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return source[open_brace : index + 1]
    raise AssertionError(f"unbalanced braces after {signature!r}")


def test_sdkconfig_profiles_compile_out_info_logs():
    """The premise of every other assertion here. If this ever stops being
    true, the ESP_LOGI bans below can be relaxed — but check the flash budget
    first."""
    defaults = ESP32_DIR / "sdkconfig.defaults"
    text = defaults.read_text()
    assert "CONFIG_LOG_DEFAULT_LEVEL_WARN=y" in text, (
        "sdkconfig.defaults no longer pins the log level to WARN; revisit "
        "whether ESP_LOGI reaches the console before relaxing these tests"
    )
    assert "CONFIG_LOG_MAXIMUM_LEVEL_INFO" not in text
    assert "CONFIG_LOG_MAXIMUM_LEVEL_DEBUG" not in text


def test_nim_log_hook_writes_to_the_console():
    """Every FrameOS log line goes through this hook. It must reach stdout
    directly — the console is the sink that works when nothing else does."""
    body = _function_body(
        _strip_comments(GLUE_C.read_text()), "void frameos_nim_log_hook("
    )
    assert re.search(r"\bprintf\s*\(", body), (
        "frameos_nim_log_hook must printf the line: at "
        "CONFIG_LOG_MAXIMUM_LEVEL=WARN an ESP_LOG* macro compiles to nothing "
        "and the USB serial console shows no device logs at all"
    )
    assert "ESP_LOGI" not in body and "ESP_LOGD" not in body, (
        "ESP_LOGI/ESP_LOGD in the log hook is compiled out — use printf"
    )


def test_cloud_session_scopes_are_logged_through_the_hook():
    """Whether the hub granted telemetry:logs decides if the frame ships logs
    at all, so the answer must be visible even when it is 'no' (which is
    exactly when it cannot travel over the cloud socket)."""
    source = CLOUD_C.read_text()
    ready_index = source.index('"scopes"')
    window = source[ready_index : ready_index + 3000]
    assert "cloud:session_ready" in window, (
        "the cloud ready handler must emit its granted scopes; without it, "
        "'this frame sends no logs' has no on-device diagnostic"
    )
    assert "frameos_nim_log_hook(" in window, (
        "the session_ready line must go through frameos_nim_log_hook (console "
        "+ ring + upload), not ESP_LOGI, which is compiled out"
    )


@pytest.mark.parametrize("source_path", [GLUE_C, CLOUD_C])
def test_sources_exist(source_path: Path):
    assert source_path.is_file(), f"missing firmware source: {source_path}"
