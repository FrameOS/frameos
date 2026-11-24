from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

# Certificate validity dates on the ESP32 (embedded/esp32/main/fos_tls_dates.h).
#
# mbedTLS was built without the check, so an expired certificate was as good
# as a current one. It is built with it now, and a frame that does not know
# the time (it counts from 1970 until SNTP answers) must still reach its plane:
# fos_tls_dates.c is that rule, pure C, and fos_tls.c tells it to mbedTLS for
# every TLS client in the image by taking the bundle's attach call at the link.

REPO_ROOT = Path(__file__).resolve().parents[4]
ESP32_DIR = REPO_ROOT / "embedded" / "esp32"
MAIN_DIR = ESP32_DIR / "main"
SOURCE = MAIN_DIR / "fos_tls_dates.c"
TEST_SOURCE = MAIN_DIR / "tests" / "test_fos_tls_dates.c"


def test_the_rule_is_pure():
    source = SOURCE.read_text() + (MAIN_DIR / "fos_tls_dates.h").read_text()
    assert "esp_" not in source and "mbedtls/" not in source and "freertos" not in source


def test_mbedtls_checks_the_dates():
    defaults = (ESP32_DIR / "sdkconfig.defaults").read_text()
    assert re.search(r"^CONFIG_MBEDTLS_HAVE_TIME_DATE=y$", defaults, re.M)
    for overlay in ESP32_DIR.glob("sdkconfig.defaults.*"):
        assert "MBEDTLS_HAVE_TIME_DATE" not in overlay.read_text(), f"{overlay.name} must not turn it off"


def test_every_client_gets_the_rule_at_the_link():
    cmake = (MAIN_DIR / "CMakeLists.txt").read_text()
    assert '"-Wl,--wrap=esp_crt_bundle_attach"' in cmake and '"-u __wrap_esp_crt_bundle_attach"' in cmake
    assert '"fos_tls.c"' in cmake and '"fos_tls_dates.c"' in cmake
    glue = (MAIN_DIR / "fos_tls.c").read_text()
    assert "esp_err_t __wrap_esp_crt_bundle_attach(void *conf)" in glue
    assert "__real_esp_crt_bundle_attach(conf)" in glue
    # The dates are made to count before the bundle's own callback reads the flags.
    verify = glue[glue.index("static int verify("):]
    assert verify.index("fos_tls_date_flags(") < verify.index("return esp_crt_verify_callback(")


def test_no_client_verifies_any_other_way():
    """Every TLS client trusts the bundle, so the one hook covers them all."""
    sources = list(MAIN_DIR.glob("*.c")) + list((ESP32_DIR / "components" / "frameos_nim").glob("*.c"))
    clients = 0
    for path in sources:
        text = path.read_text()
        clients += text.count(".crt_bundle_attach = esp_crt_bundle_attach")
        if path.name == "fos_tls.c":
            continue
        for other in ("mbedtls_ssl_conf_verify(", "skip_cert_common_name_check", "use_global_ca_store",
                      "mbedtls_ssl_conf_authmode("):
            assert other not in text, f"{path.name}: {other}"
        # A client's own CA would not pass through the bundle's attach.
        assert not re.search(r"\.cert_pem\s*=", text), f"{path.name} pins a CA of its own"
    assert clients >= 8


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
def test_host_test(tmp_path: Path):
    binary = tmp_path / "test_fos_tls_dates"
    compile_result = subprocess.run(
        ["cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", "-I", str(MAIN_DIR), str(SOURCE), str(TEST_SOURCE),
         "-o", str(binary)],
        capture_output=True,
        text=True,
    )
    assert compile_result.returncode == 0, compile_result.stderr
    result = subprocess.run([str(binary)], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
    summary = re.search(r"(\d+) checks, 0 failures", result.stdout)
    assert summary and int(summary.group(1)) >= 25
