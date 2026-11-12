from __future__ import annotations

import re
from pathlib import Path

# The ESP32's TCP/Wi-Fi buffer settings (embedded/esp32/sdkconfig.defaults,
# "TCP at the speed of the Wi-Fi"), measured on a reTerminal E1003 on
# 2026-11-10. Three things hold them together, and each one broke something
# when it was wrong:
#   - a receive window needs a socket mailbox that holds it (window / MSS + 2),
#     or lwIP closes the window it advertised;
#   - what is in flight on the send side is a DMA-capable internal copy per
#     frame: a 64 KB send buffer with 64 TX buffers drained the 64 KB DMA pool
#     to 6 KB, which the panel's SPI transfers need too;
#   - a board without PSRAM (the C3 thin client) would take every buffer from
#     internal RAM, so its overlay puts IDF's defaults back.

REPO_ROOT = Path(__file__).resolve().parents[4]
ESP32_DIR = REPO_ROOT / "embedded" / "esp32"
BASE = ESP32_DIR / "sdkconfig.defaults"
C3 = ESP32_DIR / "sdkconfig.defaults.esp32c3"

IDF_TCP_DEFAULT = 5760  # 4 * MSS: LWIP_TCP_WND_DEFAULT / LWIP_TCP_SND_BUF_DEFAULT in ESP-IDF 5.5


def _settings(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text().splitlines():
        match = re.match(r"^(CONFIG_[A-Z0-9_]+)=(.*)$", line.strip())
        if match:
            values[match.group(1)] = match.group(2)
    return values


def test_the_receive_window_has_a_mailbox_that_holds_it():
    base = _settings(BASE)
    assert base.get("CONFIG_SPIRAM_TRY_ALLOCATE_WIFI_LWIP") == "y", (
        "the big window counts on Wi-Fi and lwIP buffers coming from PSRAM"
    )
    window = int(base["CONFIG_LWIP_TCP_WND_DEFAULT"])
    assert window > IDF_TCP_DEFAULT
    mss = int(base.get("CONFIG_LWIP_TCP_MSS", "1440"))
    assert int(base["CONFIG_LWIP_TCP_RECVMBOX_SIZE"]) >= min(64, window // mss + 2)
    assert int(base["CONFIG_LWIP_TCPIP_RECVMBOX_SIZE"]) >= int(base["CONFIG_LWIP_TCP_RECVMBOX_SIZE"])
    assert int(base["CONFIG_ESP_WIFI_DYNAMIC_RX_BUFFER_NUM"]) >= window // mss


def test_the_send_side_stays_inside_the_dma_pool():
    base = _settings(BASE)
    send = int(base["CONFIG_LWIP_TCP_SND_BUF_DEFAULT"])
    tx = int(base.get("CONFIG_ESP_WIFI_DYNAMIC_TX_BUFFER_NUM", "32"))
    assert send <= 16384, "a bigger send buffer puts more DMA copies in flight than the pool holds"
    assert tx <= 32, "64 TX buffers drained the DMA-capable pool to 6 KB on the E1003"


def test_a_board_without_psram_gets_idf_defaults_back():
    c3 = _settings(C3)
    assert "CONFIG_SPIRAM" not in c3 or c3["CONFIG_SPIRAM"] != "y"
    assert int(c3["CONFIG_LWIP_TCP_WND_DEFAULT"]) == IDF_TCP_DEFAULT
    assert int(c3["CONFIG_LWIP_TCP_SND_BUF_DEFAULT"]) == IDF_TCP_DEFAULT
    assert int(c3["CONFIG_LWIP_TCP_RECVMBOX_SIZE"]) == 6
    assert int(c3["CONFIG_LWIP_TCPIP_RECVMBOX_SIZE"]) == 32
