import re
from pathlib import Path

import pytest
from unittest.mock import AsyncMock, patch

from app.models.frame import Frame
from app.tasks import embedded_firmware as embedded_firmware_module
from app.tasks.embedded_firmware import (
    FOS_PIXEL_1BPP,
    EMBEDDED_DEFAULT_FLASH_SIZE,
    EMBEDDED_DEFAULT_MAX_HTTP_RESPONSE_BYTES,
    EMBEDDED_RENDER_REMOTE,
    EMBEDDED_SUPPORTED_PANELS,
    FOS_PIXEL_2BPP_GRAY,
    FOS_PIXEL_4BPP_7COLOR,
    FOS_PIXEL_4BPP_SPECTRA6,
    FOS_PIXEL_DUAL_1BPP_RED,
    embedded_buffer_size,
    check_embedded_panel_fits_memory,
    embedded_default_pins_for_frame,
    embedded_flash_size_for_frame,
    embedded_gpio_buttons_for_frame,
    embedded_hardware_preset_for_frame,
    embedded_hostname_for_frame,
    embedded_max_http_response_bytes_for_frame,
    embedded_firmware_layout_for_frame,
    embedded_module_psram_bytes,
    embedded_ota_supported_for_frame,
    embedded_panel_for_frame,
    embedded_pins_for_frame,
    embedded_pixel_format_for_panel,
    embedded_provisioning_plan,
    embedded_release_asset_names,
    embedded_render_psram_bytes,
    embedded_render_canvas_bytes_per_pixel,
    embedded_render_mode_for_frame,
    embedded_sd_card_assets_for_frame,
    ensure_embedded_frame_defaults,
    embedded_platform_for_frame,
    normalize_embedded_flash_size,
    normalize_embedded_platform,
    request_embedded_firmware_update,
)


async def create_embedded_frame(async_client) -> dict:
    response = await async_client.post('/api/frames/new', json={
        'name': 'ESP32 Frame',
        'frame_host': '',
        'server_host': 'localhost',
        'mode': 'embedded',
        'platform': 'esp32-s3',
    })
    assert response.status_code == 200, response.text
    return response.json()['frame']


@pytest.mark.asyncio
async def test_new_embedded_frame(async_client):
    frame = await create_embedded_frame(async_client)
    assert frame['mode'] == 'embedded'
    assert frame['embedded']['platform'] == 'esp32-s3'
    assert frame['agent']['agentEnabled'] is False
    assert frame['https_proxy']['enable'] is True
    assert frame['https_proxy']['port'] == 8443
    assert 'BEGIN CERTIFICATE' in frame['https_proxy']['certs']['server']
    assert 'BEGIN RSA PRIVATE KEY' in frame['https_proxy']['certs']['server_key']
    assert 'BEGIN CERTIFICATE' in frame['https_proxy']['certs']['client_ca']
    assert frame['max_http_response_bytes'] == EMBEDDED_DEFAULT_MAX_HTTP_RESPONSE_BYTES
    assert frame['device_config']['pins']['cs'] == 3
    assert frame['device_config']['pins']['cs2'] == -1
    assert frame['embedded']['flashSize'] == EMBEDDED_DEFAULT_FLASH_SIZE
    assert frame['frame_admin_auth']['enabled'] is True
    assert frame['frame_admin_auth']['user'] == 'admin'
    assert frame['frame_admin_auth']['pass']


@pytest.mark.asyncio
async def test_new_embedded_frame_rejects_unknown_platform(async_client):
    response = await async_client.post('/api/frames/new', json={
        'name': 'ESP32 Frame',
        'frame_host': '',
        'server_host': 'localhost',
        'mode': 'embedded',
        'platform': 'arduino-uno',
    })
    assert response.status_code == 400
    assert 'Unsupported embedded platform' in response.json()['detail']


@pytest.mark.asyncio
async def test_new_embedded_photopainter_frame_adds_gpio_buttons(async_client):
    response = await async_client.post('/api/frames/new', json={
        'name': 'PhotoPainter',
        'frame_host': '',
        'server_host': 'localhost',
        'mode': 'embedded',
        'platform': 'esp32-s3',
        'device_config': {'hardwarePreset': 'waveshare_esp32_s3_photopainter'},
    })

    assert response.status_code == 200, response.text
    frame = response.json()['frame']
    assert frame['device'] == 'waveshare.EPD_7in3e'
    assert frame['gpio_buttons'] == [
        {'pin': 0, 'label': 'BOOT'},
        {'pin': 4, 'label': 'KEY1'},
    ]


@pytest.mark.asyncio
async def test_update_frame_to_embedded_applies_defaults(async_client, db):
    response = await async_client.post('/api/frames/new', json={
        'name': 'Pi Frame',
        'frame_host': 'pi.local',
        'server_host': 'localhost',
    })
    assert response.status_code == 200, response.text
    frame_id = response.json()['frame']['id']

    response = await async_client.post(f'/api/frames/{frame_id}', json={
        'mode': 'embedded',
        'network': {'wifiSSID': 'Test WiFi', 'wifiPassword': 'secret1234'},
    })
    assert response.status_code == 200, response.text

    db.expire_all()
    stored = db.get(Frame, frame_id)
    assert stored.mode == 'embedded'
    assert stored.embedded['platform'] == 'esp32-s3'
    assert stored.agent['agentEnabled'] is False
    assert stored.https_proxy['enable'] is True
    assert stored.https_proxy['port'] == 8443
    assert 'BEGIN CERTIFICATE' in stored.https_proxy['certs']['server']
    assert 'BEGIN RSA PRIVATE KEY' in stored.https_proxy['certs']['server_key']
    assert stored.log_to_file is None
    assert stored.network['wifiSSID'] == 'Test WiFi'
    assert stored.network['wifiPassword'] == 'secret1234'
    assert stored.device.startswith('waveshare.')
    assert stored.max_http_response_bytes == EMBEDDED_DEFAULT_MAX_HTTP_RESPONSE_BYTES
    assert stored.device_config['pins']['rst'] == 5
    assert stored.embedded['flashSize'] == '8MB'


def test_embedded_flash_size_profiles():
    assert normalize_embedded_flash_size(None) == '8MB'
    assert normalize_embedded_flash_size('4mb') == '4MB'
    assert normalize_embedded_flash_size('32 MB') == '32MB'
    assert normalize_embedded_flash_size(16) == '16MB'
    assert normalize_embedded_flash_size('2MB') == '2MB'  # Pico W
    with pytest.raises(ValueError):
        normalize_embedded_flash_size('3MB')

    default_frame = Frame()
    assert embedded_flash_size_for_frame(default_frame) == '8MB'
    assert embedded_ota_supported_for_frame(default_frame) is True

    device_config_frame = Frame(device_config={'flashSize': '4MB'})
    ensure_embedded_frame_defaults(device_config_frame)
    assert device_config_frame.embedded['flashSize'] == '4MB'

    four_mb = Frame(embedded={'flashSize': '4MB'})
    assert embedded_flash_size_for_frame(four_mb) == '4MB'
    assert embedded_ota_supported_for_frame(four_mb) is False

    thirty_two_mb = Frame(embedded={'flashSize': '32MB'})
    assert embedded_flash_size_for_frame(thirty_two_mb) == '32MB'
    assert embedded_ota_supported_for_frame(thirty_two_mb) is True
    # Each layout names the release image built with exactly that partition
    # table -- what a board is flashed with, since nothing is built here.
    assert embedded_firmware_module.EMBEDDED_FLASH_PROFILES['32MB']['releaseAssets'] == {
        'esp32-s3': 'esp32-s3-32mb', 'esp32-c3': 'esp32-c3-32mb',
    }


def test_embedded_firmware_layout_tracks_flash_and_ram():
    frame = Frame(
        mode='embedded',
        device='waveshare.EPD_13in3e',
        embedded={'platform': 'esp32-s3', 'flashSize': '32MB'},
        device_config={'psramMB': 16},
    )

    layout = embedded_firmware_layout_for_frame(frame)

    assert layout['flash']['flashBytes'] == 32 * 1024 * 1024
    assert layout['flash']['partitionTable'] == 'partitions_ota_32mb.csv'
    ota_0 = next(partition for partition in layout['flash']['partitions'] if partition['name'] == 'ota_0')
    ota_1 = next(partition for partition in layout['flash']['partitions'] if partition['name'] == 'ota_1')
    state = next(partition for partition in layout['flash']['partitions'] if partition['name'] == 'state')
    assert ota_0['offset'] == 0x20000
    assert ota_0['size'] == 0x3F0000
    # The image is a release asset, not something this backend built: how many
    # bytes of a slot it fills is not knowable here.
    assert ota_0['usedBytes'] is None
    assert ota_1['offset'] == 0x410000
    assert ota_1['size'] == 0x3F0000
    assert ota_1['usedBytes'] is None
    assert state['offset'] == 0x800000
    assert state['size'] == 24 * 1024 * 1024
    assert state['end'] == 32 * 1024 * 1024
    assert layout['ram']['psramBytes'] == 16 * 1024 * 1024
    assert layout['ram']['width'] == 1200
    assert layout['ram']['height'] == 1600
    assert layout['ram']['pixelFormat'] == FOS_PIXEL_4BPP_SPECTRA6
    # 1200x1600 on a 16 MB module: a full RGBX canvas (7.3 MB) takes under
    # half the PSRAM, so the canvas is 4 B/px; the old key name stays for the UI.
    assert layout['ram']['canvasBytesPerPixel'] == 4
    assert layout['ram']['canvasBufferBytes'] == 1200 * 1600 * 4
    assert layout['ram']['rgbaBufferBytes'] == layout['ram']['canvasBufferBytes']
    assert layout['ram']['packedBufferBytes'] == 960_000
    assert layout['ram']['renderWorkingBytes'] > layout['ram']['canvasBufferBytes']


def test_embedded_firmware_layout_keeps_large_16mb_state_partition():
    frame = Frame(
        mode='embedded',
        embedded={'platform': 'esp32-s3', 'flashSize': '16MB'},
    )

    layout = embedded_firmware_layout_for_frame(frame)

    assert layout['flash']['flashBytes'] == 16 * 1024 * 1024
    assert layout['flash']['partitionTable'] == 'partitions_ota_16mb.csv'
    ota_0 = next(partition for partition in layout['flash']['partitions'] if partition['name'] == 'ota_0')
    ota_1 = next(partition for partition in layout['flash']['partitions'] if partition['name'] == 'ota_1')
    state = next(partition for partition in layout['flash']['partitions'] if partition['name'] == 'state')
    assert ota_0['offset'] == 0x20000
    assert ota_0['size'] == 0x3F0000
    # The image is a release asset, not something this backend built: how many
    # bytes of a slot it fills is not knowable here.
    assert ota_0['usedBytes'] is None
    assert ota_1['offset'] == 0x410000
    assert ota_1['size'] == 0x3F0000
    assert ota_1['usedBytes'] is None
    assert state['offset'] == 0x800000
    assert state['size'] == 8 * 1024 * 1024
    assert state['end'] == 16 * 1024 * 1024


@pytest.mark.asyncio
async def test_frame_get_embedded_includes_the_flash_layout(async_client, db):
    """The deploy drawer draws the board's flash layout and memory plan. It is
    derived on every read from the frame's platform + flash size — the frame
    row carries no build state, and a stored `embedded.firmware` blob left
    over from the build era is never echoed back."""
    frame = await create_embedded_frame(async_client)

    stored = db.get(Frame, frame['id'])
    stored.embedded = {**(stored.embedded or {}), 'firmware': {'status': 'ready', 'path': '/tmp/old.bin'}}
    db.add(stored)
    db.commit()

    response = await async_client.get(f"/api/frames/{frame['id']}")

    assert response.status_code == 200
    embedded = response.json()['frame']['embedded']
    assert 'firmware' not in embedded
    layout = embedded['layout']
    assert layout['flash']['flashBytes'] == 8 * 1024 * 1024
    assert layout['flash']['partitionTable'] == 'partitions.csv'
    assert layout['flash']['otaSupported'] is True
    assert [partition['name'] for partition in layout['flash']['partitions']] == [
        'bootloader',
        'partition_table',
        'nvs',
        'otadata',
        'phy_init',
        'ota_0',
        'ota_1',
        'state',
    ]
    assert layout['ram']['panel'] == 'EPD_7in5_V2'
    assert layout['ram']['rgbaBufferBytes'] > 0
    assert layout['ram']['packedBufferBytes'] > 0
    assert layout['ram']['renderWorkingBytes'] > 0


@pytest.mark.asyncio
async def test_firmware_endpoints_reject_non_embedded_frames(async_client):
    """Only the OTA poke is left of the firmware routes; the build/download
    pair went with the per-frame builds."""
    response = await async_client.post('/api/frames/new', json={
        'name': 'Pi Frame',
        'frame_host': 'pi@localhost',
        'server_host': 'localhost',
    })
    assert response.status_code == 200
    frame_id = response.json()['frame']['id']

    response = await async_client.post(f'/api/frames/{frame_id}/embedded/firmware/ota')
    assert response.status_code == 400, response.text

    for method, url in [
        ('GET', f'/api/frames/{frame_id}/embedded/firmware'),
        ('POST', f'/api/frames/{frame_id}/embedded/firmware'),
        ('GET', f'/api/frames/{frame_id}/embedded/firmware/download'),
    ]:
        response = await async_client.request(method, url)
        assert response.status_code in (404, 405), (url, response.status_code)


def test_embedded_panel_matrix_includes_new_panels():
    # The backend panel set and ESP32 selected-panel generator must stay in sync.
    # This covers representative formats: 1bpp, dual-plane, 4-gray, 7-color,
    # and Spectra 6.
    for panel in ("EPD_7in5_V2", "EPD_7in5", "EPD_5in83", "EPD_4in2_V2",
                  "EPD_2in9_V2", "EPD_2in66", "EPD_2in13_V4", "EPD_1in54_V2",
                  "EPD_7in3e", "EPD_4in0e", "EPD_13in3e", "EPD_7in3f",
                  "EPD_5in65f", "EPD_7in3g", "EPD_10in2b"):
        assert panel in EMBEDDED_SUPPORTED_PANELS
        assert embedded_panel_for_frame(Frame(device=f"waveshare.{panel}")) == panel
    # Unsupported non-generic buses fall back to headless rather than a bad build.
    assert embedded_panel_for_frame(Frame(device="waveshare.EPD_10in3")) == "none"
    assert embedded_panel_for_frame(Frame(device="waveshare.EPD_12in48")) == "none"


def test_embedded_panel_formats_and_buffer_sizes():
    assert embedded_pixel_format_for_panel("EPD_2in9_V2") == FOS_PIXEL_2BPP_GRAY
    assert embedded_pixel_format_for_panel("EPD_4in2_V2") == FOS_PIXEL_2BPP_GRAY
    assert embedded_pixel_format_for_panel("EPD_10in2b") == FOS_PIXEL_DUAL_1BPP_RED
    assert embedded_pixel_format_for_panel("EPD_7in3f") == FOS_PIXEL_4BPP_7COLOR
    assert embedded_pixel_format_for_panel("EPD_7in3e") == FOS_PIXEL_4BPP_SPECTRA6
    assert embedded_buffer_size(128, 296, FOS_PIXEL_2BPP_GRAY) == ((128 + 3) // 4) * 296
    assert embedded_buffer_size(1200, 1600, FOS_PIXEL_4BPP_SPECTRA6) == 600 * 1600


def test_embedded_render_canvas_bytes_per_pixel():
    mb = 1024 * 1024
    # RGBX whenever a full canvas is at most half the module's PSRAM.
    assert embedded_render_canvas_bytes_per_pixel(800, 480, 8 * mb) == 4      # 1.5 MB of 8
    assert embedded_render_canvas_bytes_per_pixel(1200, 1600, 16 * mb) == 4   # 7.3 MB of 16
    assert embedded_render_canvas_bytes_per_pixel(1200, 1600, 8 * mb) == 2    # 7.3 MB of 8
    assert embedded_render_canvas_bytes_per_pixel(0, 0, 8 * mb) == 0


def test_embedded_render_psram_estimate():
    mb = 1024 * 1024
    # 800x480 on 8 MB: RGBX canvas (1.5 MB) + default packed 1bpp + ~1.5MB reserve is ~3.1MB.
    need = embedded_render_psram_bytes(800, 480)
    assert 3_000_000 < need < 3_200_000
    # 1200x1600 Spectra 6 on 8 MB: 3.84MB 565 canvas + 960KB packed + 1.5MB reserve, under 8MB.
    need = embedded_render_psram_bytes(1200, 1600, FOS_PIXEL_4BPP_SPECTRA6, 8 * mb)
    assert 6_300_000 < need < 6_400_000
    assert need < 8 * mb
    # The same panel on 16 MB gets the RGBX canvas: 7.68MB + 960KB + 1.5MB, under 16MB.
    need = embedded_render_psram_bytes(1200, 1600, FOS_PIXEL_4BPP_SPECTRA6, 16 * mb)
    assert 10_100_000 < need < 10_300_000
    assert need < 16 * mb


def test_panel_fits_default_8mb_module():
    # Representative large 1bpp panel fits a stock 8MB S3 module.
    frame = Frame(device="waveshare.EPD_7in5_V2")
    assert embedded_module_psram_bytes(frame) == 8 * 1024 * 1024
    check_embedded_panel_fits_memory(frame)  # must not raise


def test_panel_too_large_for_small_psram_is_rejected():
    frame = Frame(device="waveshare.EPD_7in5_V2", device_config={"psramMB": 2})
    assert embedded_module_psram_bytes(frame) == 2 * 1024 * 1024
    with pytest.raises(ValueError) as exc:
        check_embedded_panel_fits_memory(frame)
    assert "PSRAM" in str(exc.value)


def test_large_spectra_panel_renders_locally_on_8mb_module():
    # 1200x1600 used to need the 16MB module (7.3MB RGBA canvas); with the
    # 16-bit canvas it fits the stock 8MB one — the reTerminal E1004 case.
    frame = Frame(device="waveshare.EPD_13in3e")
    assert embedded_module_psram_bytes(frame) == 8 * 1024 * 1024
    check_embedded_panel_fits_memory(frame)  # must not raise

    frame.device_config = {"psramMB": 16, "pins": {"cs2": 8}}
    check_embedded_panel_fits_memory(frame)

    # A module that really is too small is still refused with a clear reason.
    frame.device_config = {"psramMB": 4}
    with pytest.raises(ValueError) as exc:
        check_embedded_panel_fits_memory(frame)
    assert "13in3e" in str(exc.value)
    assert "PSRAM" in str(exc.value)


def test_embedded_defaults_choose_response_limit_and_pin_layout():
    frame = Frame(
        id=7,
        device="waveshare.EPD_13in3e",
        max_http_response_bytes=64 * 1024 * 1024,
        device_config={"psramMB": 16},
    )
    ensure_embedded_frame_defaults(frame)
    assert frame.frame_port == 80
    assert frame.max_http_response_bytes == EMBEDDED_DEFAULT_MAX_HTTP_RESPONSE_BYTES
    assert frame.device_config["pins"]["cs2"] == 8
    assert embedded_default_pins_for_frame(frame)["cs2"] == 8
    assert frame.frame_admin_auth["enabled"] is True
    assert frame.frame_admin_auth["user"] == "admin"
    assert frame.frame_admin_auth["pass"]

    custom_port = Frame(device="waveshare.EPD_7in5_V2", frame_port=8081)
    ensure_embedded_frame_defaults(custom_port)
    assert custom_port.frame_port == 8081

    disabled_admin = Frame(
        device="waveshare.EPD_7in5_V2",
        frame_admin_auth={"enabled": False, "user": "", "pass": ""},
    )
    ensure_embedded_frame_defaults(disabled_admin)
    assert disabled_admin.frame_admin_auth == {"enabled": False, "user": "", "pass": ""}

    custom = Frame(
        device="waveshare.EPD_7in5_V2",
        max_http_response_bytes=3 * 1024 * 1024,
        device_config={"pins": {"rst": 12, "sclk": 11}},
    )
    assert embedded_max_http_response_bytes_for_frame(custom) == 3 * 1024 * 1024
    assert embedded_pins_for_frame(custom)["rst"] == 12
    assert embedded_pins_for_frame(custom)["sck"] == 11


def test_embedded_hardware_preset_for_waveshare_13in3e6():
    frame = Frame(
        id=7,
        device_config={"hardwarePreset": "waveshare_esp32_s3_epaper_13_3e6"},
    )

    ensure_embedded_frame_defaults(frame)

    assert embedded_hardware_preset_for_frame(frame) == "waveshare_esp32_s3_epaper_13_3e6"
    assert frame.device == "waveshare.EPD_13in3e"
    assert frame.embedded["flashSize"] == "32MB"
    assert embedded_flash_size_for_frame(frame) == "32MB"
    assert embedded_module_psram_bytes(frame) == 16 * 1024 * 1024
    assert frame.device_config["psramMB"] == 16
    assert embedded_pins_for_frame(frame) == {
        "rst": 2,
        "dc": 11,
        "cs": 10,
        "cs2": 3,
        "busy": 12,
        "sck": 9,
        "mosi": 46,
        "pwr": 1,
    }
    assert embedded_sd_card_assets_for_frame(frame) == {
        "enabled": True,
        "preset": "waveshare_esp32_s3_epaper_13_3e6",
        "mountPath": "/srv/assets",
        "pins": {"cs": 15, "sck": 6, "miso": 5, "mosi": 7},
        "maxFrequencyKHz": 20_000,
    }
    check_embedded_panel_fits_memory(frame)

    # The USB console provisions what a per-frame build used to bake in.
    settings = _provisioned(embedded_provisioning_plan(frame))
    assert settings["panel"] == "EPD_13in3e"
    assert settings["pins"] == "rst=2,dc=11,cs=10,cs2=3,busy=12,sck=9,mosi=46,pwr=1"
    assert settings["assets_sd_pins"] == "cs=15,sck=6,miso=5,mosi=7"
    assert settings["assets_sd"] == "1"
    # Battery: VBAT on ADC1_CH7 = GPIO8 through a 1/3 divider (vendor ADC
    # examples read CHANNEL_7 and multiply the calibrated voltage by 3).
    assert frame.device_config["batteryPin"] == 8
    assert frame.device_config["batteryDivider"] == 3.0
    assert settings["battery_pin"] == "8"
    assert settings["battery_divider"] == "3.0"
    # Scaling mode: unset falls back to the embedded default "cover"; a
    # configured value is provisioned, an unknown one is refused server-side.
    assert settings["scaling_mode"] == "cover"
    frame.scaling_mode = "contain"
    assert _provisioned(embedded_provisioning_plan(frame))["scaling_mode"] == "contain"
    frame.scaling_mode = "diagonal"
    assert _provisioned(embedded_provisioning_plan(frame))["scaling_mode"] == "cover"
    frame.scaling_mode = None


def test_embedded_hardware_preset_for_waveshare_photopainter():
    frame = Frame(
        id=8,
        embedded={"hardwarePreset": "waveshare_esp32_s3_photopainter"},
    )

    ensure_embedded_frame_defaults(frame)

    assert embedded_hardware_preset_for_frame(frame) == "waveshare_esp32_s3_photopainter"
    assert frame.device == "waveshare.EPD_7in3e"
    assert frame.embedded["flashSize"] == "16MB"
    assert embedded_flash_size_for_frame(frame) == "16MB"
    assert embedded_module_psram_bytes(frame) == 8 * 1024 * 1024
    assert frame.device_config["psramMB"] == 8
    assert embedded_pins_for_frame(frame) == {
        "rst": 12,
        "dc": 8,
        "cs": 9,
        "cs2": -1,
        "busy": 13,
        "sck": 10,
        "mosi": 11,
        "pwr": -1,
    }
    assert embedded_sd_card_assets_for_frame(frame) == {
        "enabled": True,
        "preset": "waveshare_esp32_s3_photopainter",
        "mountPath": "/srv/assets",
        "pins": {"cs": 38, "sck": 39, "miso": 40, "mosi": 41},
        "maxFrequencyKHz": 20_000,
    }
    assert frame.gpio_buttons == [
        {"pin": 0, "label": "BOOT"},
        {"pin": 4, "label": "KEY1"},
    ]
    assert embedded_gpio_buttons_for_frame(frame) == [(0, "BOOT"), (4, "KEY1")]
    check_embedded_panel_fits_memory(frame)

    settings = _provisioned(embedded_provisioning_plan(frame))
    assert settings["hardware"] == "waveshare_esp32_s3_photopainter"
    # The console takes the button spec comma-separated, not newline-separated.
    assert settings["gpio_buttons"] == "0:BOOT,4:KEY1"
    assert settings["panel"] == "EPD_7in3e"
    assert settings["pins"] == "rst=12,dc=8,cs=9,cs2=-1,busy=13,sck=10,mosi=11,pwr=-1"
    assert settings["assets_sd_pins"] == "cs=38,sck=39,miso=40,mosi=41"
    assert settings["assets_sd"] == "1"


def test_normalize_embedded_platform():
    assert normalize_embedded_platform(None) == "esp32-s3"
    assert normalize_embedded_platform("") == "esp32-s3"
    assert normalize_embedded_platform("esp32s3") == "esp32-s3"
    assert normalize_embedded_platform("esp32-s3-devkitc-1") == "esp32-s3"
    assert normalize_embedded_platform("esp32-c3") == "esp32-c3"
    assert normalize_embedded_platform("esp32c3") == "esp32-c3"
    assert normalize_embedded_platform("ESP32-C3") == "esp32-c3"
    with pytest.raises(ValueError):
        normalize_embedded_platform("esp32-p4")


def test_embedded_hardware_preset_for_trmnl_og():
    frame = Frame(id=9, embedded={"hardwarePreset": "trmnl_og"})

    ensure_embedded_frame_defaults(frame)

    assert frame.device == "waveshare.EPD_7in5_V2"
    assert frame.embedded["platform"] == "esp32-c3"
    assert embedded_platform_for_frame(frame) == "esp32-c3"
    assert embedded_flash_size_for_frame(frame) == "4MB"
    assert embedded_ota_supported_for_frame(frame) is False
    assert embedded_module_psram_bytes(frame) == 0
    # No PSRAM: local rendering is impossible, the platform forces thin-client.
    assert embedded_render_mode_for_frame(frame) == EMBEDDED_RENDER_REMOTE
    # Remote mode always passes the guardrail regardless of PSRAM.
    check_embedded_panel_fits_memory(frame)
    assert embedded_pins_for_frame(frame) == {
        "rst": 10, "dc": 5, "cs": 6, "cs2": -1,
        "busy": 4, "sck": 7, "mosi": 8, "pwr": -1,
    }
    assert frame.gpio_buttons == [{"pin": 2, "label": "BUTTON"}]
    # VBAT through a 2:1 divider on GPIO3 (trmnl-firmware PIN_BATTERY 3, no
    # load switch) — the metrics battery gauge on a stock TRMNL.
    assert frame.device_config["batteryPin"] == 3
    assert frame.device_config["batteryDivider"] == 2.0
    assert "batteryEnablePin" not in frame.device_config
    assert embedded_sd_card_assets_for_frame(frame)["enabled"] is False
    assert embedded_flash_size_for_frame(frame) == "4MB"
    assert embedded_ota_supported_for_frame(frame) is False


def test_embedded_hardware_preset_for_esp32_c3_042_oled():
    frame = Frame(id=11, embedded={"hardwarePreset": "esp32_c3_042_oled"})
    ensure_embedded_frame_defaults(frame)
    assert frame.device == "oled.ssd1306_72x40"
    assert embedded_panel_for_frame(frame) == "OLED_SSD1306_72x40"
    assert embedded_platform_for_frame(frame) == "esp32-c3"
    assert embedded_render_mode_for_frame(frame) == EMBEDDED_RENDER_REMOTE
    assert embedded_pixel_format_for_panel(embedded_panel_for_frame(frame)) == FOS_PIXEL_1BPP
    assert embedded_buffer_size(72, 40, FOS_PIXEL_1BPP) == 360
    assert frame.device_config["pins"]["sck"] == 6
    assert frame.device_config["pins"]["mosi"] == 5
    assert "batteryPin" not in frame.device_config


def test_embedded_panel_for_oled_device_without_preset():
    frame = Frame(id=12, device="oled.ssd1306_72x40", embedded={"platform": "esp32-c3"})
    assert embedded_panel_for_frame(frame) == "OLED_SSD1306_72x40"


def test_embedded_hardware_preset_for_trmnl_bwry():
    frame = Frame(id=9, embedded={"hardwarePreset": "trmnl_bwry"})
    ensure_embedded_frame_defaults(frame)
    assert frame.device == "waveshare.EPD_7in5yr"
    assert embedded_panel_for_frame(frame) == "EPD_7in5yr"
    assert embedded_platform_for_frame(frame) == "esp32-c3"
    assert embedded_render_mode_for_frame(frame) == EMBEDDED_RENDER_REMOTE
    assert frame.device_config["batteryPin"] == 3
    assert frame.device_config["batteryDivider"] == 2.0


def test_embedded_hardware_preset_for_xteink_x4():
    frame = Frame(id=9, embedded={"hardwarePreset": "xteink_x4"})

    ensure_embedded_frame_defaults(frame)

    assert frame.device == "waveshare.EPD_4in26"
    assert embedded_platform_for_frame(frame) == "esp32-c3"
    assert embedded_flash_size_for_frame(frame) == "16MB"
    assert embedded_ota_supported_for_frame(frame) is True
    assert embedded_module_psram_bytes(frame) == 0
    assert embedded_render_mode_for_frame(frame) == EMBEDDED_RENDER_REMOTE
    check_embedded_panel_fits_memory(frame)
    pins = embedded_pins_for_frame(frame)
    assert pins == {
        "rst": 5, "dc": 4, "cs": 21, "cs2": -1,
        "busy": 6, "sck": 8, "mosi": 10, "pwr": -1,
    }
    # Every pin fits the C3's GPIO range (0-21).
    assert all(-1 <= pin <= 21 for pin in pins.values())
    assert frame.gpio_buttons == [{"pin": 3, "label": "POWER"}]
    # 2:1 divider on GPIO0 = ADC1_CH0 (trmnl-firmware PIN_BATTERY 0).
    assert frame.device_config["batteryPin"] == 0
    assert frame.device_config["batteryDivider"] == 2.0
    assert "batteryEnablePin" not in frame.device_config


def test_embedded_pins_clamp_uses_platform_gpio_range():
    frame = Frame(
        id=9,
        embedded={"hardwarePreset": "trmnl_og"},
        device_config={"hardwarePreset": "trmnl_og", "pins": {"rst": 38}},
    )
    # GPIO 38 does not exist on the C3; the override is ignored.
    assert embedded_pins_for_frame(frame)["rst"] == 10


def test_embedded_hardware_preset_for_seeed_reterminal_sticky():
    frame = Frame(id=9, embedded={"hardwarePreset": "seeed_reterminal_sticky"})

    ensure_embedded_frame_defaults(frame)

    assert frame.device == "waveshare.EPD_3in97"
    assert embedded_panel_for_frame(frame) == "EPD_3in97"
    assert embedded_platform_for_frame(frame) == "esp32-s3"
    assert embedded_flash_size_for_frame(frame) == "32MB"
    assert embedded_module_psram_bytes(frame) == 8 * 1024 * 1024
    # PSRAM on board: local rendering stays available.
    assert embedded_render_mode_for_frame(frame) != EMBEDDED_RENDER_REMOTE
    check_embedded_panel_fits_memory(frame)
    assert embedded_pins_for_frame(frame) == {
        "rst": 17, "dc": 16, "cs": 15, "cs2": -1,
        "busy": 18, "sck": 13, "mosi": 14, "pwr": -1,
    }
    assert embedded_flash_size_for_frame(frame) == "32MB"
    assert embedded_firmware_module.embedded_platform_spec_for_frame(frame)["idfTarget"] == "esp32s3"


def test_embedded_hardware_preset_for_seeed_reterminal_e10xx():
    for preset, panel in (
        ("seeed_reterminal_e1001", "EPD_7in5_V2"),
        ("seeed_reterminal_e1002", "EPD_7in3e"),
    ):
        frame = Frame(id=9, embedded={"hardwarePreset": preset})
        ensure_embedded_frame_defaults(frame)
        assert embedded_panel_for_frame(frame) == panel
        assert embedded_platform_for_frame(frame) == "esp32-s3"
        assert embedded_flash_size_for_frame(frame) == "32MB"
        assert embedded_module_psram_bytes(frame) == 8 * 1024 * 1024
        check_embedded_panel_fits_memory(frame)
        # Both boards share the same EPD wiring (Zephyr DTS + TRMNL firmware).
        assert embedded_pins_for_frame(frame) == {
            "rst": 12, "dc": 11, "cs": 10, "cs2": -1,
            "busy": 13, "sck": 7, "mosi": 9, "pwr": -1,
        }
        assert frame.gpio_buttons == [
            {"pin": 3, "label": "REFRESH"},
            {"pin": 4, "label": "LEFT"},
            {"pin": 5, "label": "RIGHT"},
        ]
        # Same switched 2:1 divider as the E1004 per Seeed's schematic
        # (hardware-unverified on these two); no shipped power policy.
        assert frame.device_config["batteryPin"] == 1
        assert frame.device_config["batteryDivider"] == 2.0
        assert frame.device_config["batteryEnablePin"] == 21
        assert "deepSleepOnBattery" not in frame.device_config
        assert "wakeCheckSeconds" not in frame.device_config
        assert embedded_sd_card_assets_for_frame(frame)["enabled"] is False


def test_embedded_hardware_preset_for_seeed_reterminal_e1004():
    frame = Frame(id=9, embedded={"hardwarePreset": "seeed_reterminal_e1004"})

    ensure_embedded_frame_defaults(frame)

    assert embedded_panel_for_frame(frame) == "EPD_13in3e"
    assert embedded_platform_for_frame(frame) == "esp32-s3"
    assert embedded_flash_size_for_frame(frame) == "32MB"
    # 8MB PSRAM and a 1200x1600 panel: renders on-device thanks to the
    # 16-bit canvas; this is the whole reason that canvas exists.
    assert embedded_module_psram_bytes(frame) == 8 * 1024 * 1024
    assert embedded_render_mode_for_frame(frame) != EMBEDDED_RENDER_REMOTE
    check_embedded_panel_fits_memory(frame)
    assert embedded_pins_for_frame(frame) == {
        "rst": 38, "dc": 11, "cs": 10, "cs2": 2,
        "busy": 13, "sck": 7, "mosi": 9, "pwr": 12,
    }
    # The E-series trio (Seeed's ESPHome cookbook), same as the E1001/E1002.
    assert frame.gpio_buttons == [
        {"pin": 3, "label": "REFRESH"},
        {"pin": 4, "label": "LEFT"},
        {"pin": 5, "label": "RIGHT"},
    ]
    # Battery behind a switched 2:1 divider, and a battery power policy: the
    # board ships sleeping between renders on battery, checking in every 15 min.
    assert frame.device_config["batteryPin"] == 1
    assert frame.device_config["batteryDivider"] == 2.0
    assert frame.device_config["batteryEnablePin"] == 21
    assert frame.device_config["deepSleepOnBattery"] is True
    assert frame.device_config["wakeCheckSeconds"] == 900
    assert embedded_sd_card_assets_for_frame(frame)["enabled"] is False
    plan = embedded_provisioning_plan(frame)
    settings = _provisioned(plan)
    assert plan["settings"][0]["key"] == "hardware"
    assert settings["hardware"] == "seeed_reterminal_e1004"
    assert settings["panel"] == "EPD_13in3e"
    assert settings["pins"] == "rst=38,dc=11,cs=10,cs2=2,busy=13,sck=7,mosi=9,pwr=12"
    assert settings["render_mode"] == "local"
    # The console has a `set` key for every battery/power value the image
    # would bake in, so the generic-image path provisions the same frame.
    assert settings["battery_pin"] == "1"
    assert settings["battery_divider"] == "2.0"
    assert settings["battery_enable_pin"] == "21"
    assert settings["deep_sleep_on_battery"] == "1"
    assert settings["wake_check"] == "900"
    assert embedded_flash_size_for_frame(frame) == "32MB"


def test_embedded_hardware_preset_only_seeds_user_editable_power_settings():
    """The preset runs again on every PATCH and before every build
    (ensure_embedded_frame_defaults), so the battery wiring and power policy
    it ships are seeds: a value the user set in the Power section survives."""
    frame = Frame(id=9, embedded={"hardwarePreset": "seeed_reterminal_e1004"})
    ensure_embedded_frame_defaults(frame)
    assert frame.device_config["deepSleepOnBattery"] is True
    assert frame.device_config["wakeCheckSeconds"] == 900

    # The user unchecks "Deep sleep on battery", shortens the wake check and
    # rewires the battery sense; the next save re-applies the preset.
    frame.device_config = {
        **frame.device_config,
        "deepSleepOnBattery": False,
        "wakeCheckSeconds": 300,
        "batteryPin": -1,
        "batteryDivider": 3.0,
        "batteryEnablePin": -1,
    }
    ensure_embedded_frame_defaults(frame)

    assert frame.device_config["deepSleepOnBattery"] is False
    assert frame.device_config["wakeCheckSeconds"] == 300
    assert frame.device_config["batteryPin"] == -1
    assert frame.device_config["batteryDivider"] == 3.0
    assert frame.device_config["batteryEnablePin"] == -1
    # Board-fixed values still come from the preset.
    assert frame.device_config["pins"]["cs2"] == 2
    assert frame.device_config["psramMB"] == 8

    # Clearing a key hands it back to the preset on the next apply, while a
    # snake_case spelling of it (older SPA saves) still counts as set.
    frame.device_config = {
        **{
            key: value for key, value in frame.device_config.items()
            if key not in ("deepSleepOnBattery", "wakeCheckSeconds")
        },
        "wake_check_seconds": 120,
    }
    ensure_embedded_frame_defaults(frame)
    assert frame.device_config["deepSleepOnBattery"] is True
    assert "wakeCheckSeconds" not in frame.device_config
    assert frame.device_config["wake_check_seconds"] == 120
    assert frame.device_config["batteryPin"] == -1


def test_embedded_hardware_preset_for_elecrow_crowpanel_5in79():
    frame = Frame(id=9, embedded={"hardwarePreset": "elecrow_crowpanel_5in79"})

    ensure_embedded_frame_defaults(frame)

    assert embedded_panel_for_frame(frame) == "EPD_5in79"
    assert embedded_platform_for_frame(frame) == "esp32-s3"
    assert embedded_flash_size_for_frame(frame) == "8MB"
    assert embedded_module_psram_bytes(frame) == 8 * 1024 * 1024
    check_embedded_panel_fits_memory(frame)
    assert embedded_pins_for_frame(frame) == {
        "rst": 47, "dc": 46, "cs": 45, "cs2": -1,
        "busy": 48, "sck": 12, "mosi": 11, "pwr": -1,
    }
    assert {"pin": 2, "label": "HOME"} in frame.gpio_buttons
    assert {"pin": 5, "label": "OK"} in frame.gpio_buttons


def test_embedded_hardware_preset_for_inky_frames():
    for preset, panel, platform, flash in (
        ("pimoroni_inky_frame_4", "EPD_4in01f", "pico-w", "2MB"),
        ("pimoroni_inky_frame_5_7", "EPD_5in65f", "pico-w", "2MB"),
        ("pimoroni_inky_frame_7_3", "EPD_7in3f", "pico-w", "2MB"),
        ("pimoroni_inky_frame_7_3_pico2", "EPD_7in3f", "pico-2w", "4MB"),
        ("pimoroni_inky_frame_7_3_spectra", "EPD_7in3e", "pico-2w", "4MB"),
    ):
        frame = Frame(id=9, embedded={"hardwarePreset": preset})
        ensure_embedded_frame_defaults(frame)
        assert embedded_panel_for_frame(frame) == panel
        assert embedded_platform_for_frame(frame) == platform
        assert embedded_flash_size_for_frame(frame) == flash
        assert embedded_ota_supported_for_frame(frame) is False
        assert embedded_module_psram_bytes(frame) == 0
        # Pico family: thin client always, no ESP-IDF build inputs.
        assert embedded_render_mode_for_frame(frame) == EMBEDDED_RENDER_REMOTE
        check_embedded_panel_fits_memory(frame)
        # The shift-register wiring rides along in device_config for the
        # pico firmware's provisioning flow.
        assert frame.device_config["pins"]["sr_clock"] == 8
        assert frame.device_config["pins"]["busy_bit"] == 7
        # Layout must not crash without a partition table.
        layout = embedded_firmware_layout_for_frame(frame)
        assert layout["flash"]["flashBytes"] == (2 if flash == "2MB" else 4) * 1024 * 1024


def test_embedded_hardware_preset_for_trmnl_diy_kits():
    for preset, panel, button in (
        ("trmnl_og_diy_kit", "EPD_7in5_V2", {"pin": 5, "label": "KEY3"}),
        ("trmnl_4in26_diy_kit", "EPD_4in26", {"pin": 2, "label": "KEY1"}),
    ):
        frame = Frame(id=9, embedded={"hardwarePreset": preset})
        ensure_embedded_frame_defaults(frame)
        assert embedded_panel_for_frame(frame) == panel
        assert embedded_platform_for_frame(frame) == "esp32-s3"
        assert embedded_flash_size_for_frame(frame) == "8MB"
        assert embedded_pins_for_frame(frame) == {
            "rst": 38, "dc": 10, "cs": 44, "cs2": -1,
            "busy": 4, "sck": 7, "mosi": 9, "pwr": -1,
        }
        assert button in frame.gpio_buttons
        # The driver board's battery divider sits behind a load switch on
        # GPIO6 (trmnl-firmware PIN_BATTERY 1 / PIN_VBAT_SWITCH 6, active high).
        assert frame.device_config["batteryPin"] == 1
        assert frame.device_config["batteryDivider"] == 2.0
        assert frame.device_config["batteryEnablePin"] == 6


_FOS_CONSOLE_C = Path(__file__).resolve().parents[4] / "embedded" / "esp32" / "main" / "fos_console.c"


def _console_hardware_presets() -> dict[str, dict]:
    """The `set hardware` table in fos_console.c, parsed from source: the
    device applies it over USB when the cloud flasher provisions a board, so
    it is the copy that decides what a cloud-flashed frame actually runs."""
    source = _FOS_CONSOLE_C.read_text(encoding="utf-8")
    table = re.search(r"\} presets\[\] = \{(.*?)\n        \};", source, re.DOTALL)
    assert table, "presets[] table not found in fos_console.c"
    body = re.sub(r"/\*.*?\*/", "", table.group(1), flags=re.DOTALL)
    entry = re.compile(
        r'\{\s*"(?P<name>[a-z0-9_]+)",\s*"(?P<panel>[A-Za-z0-9_]+)",\s*"(?P<pins>[^"]*)",'
        r'\s*"(?P<buttons>[^"]*)",\s*"(?P<sd_pins>[^"]*)",'
        r"\s*(?P<battery_pin>-?\d+),\s*(?P<battery_divider>[\d.]+)f,\s*(?P<battery_enable_pin>-?\d+),"
        r"\s*(?P<deep_sleep_on_battery>\d+),\s*(?P<wake_check>\d+)\s*\}"
    )
    presets = {}
    for match in entry.finditer(body):
        presets[match.group("name")] = {
            "panel": match.group("panel"),
            "pins": match.group("pins"),
            "gpio_buttons": match.group("buttons").replace("\\n", ","),
            "assets_sd_pins": match.group("sd_pins"),
            "battery_pin": match.group("battery_pin"),
            "battery_divider": float(match.group("battery_divider")),
            "battery_enable_pin": match.group("battery_enable_pin"),
            "deep_sleep_on_battery": match.group("deep_sleep_on_battery") == "1",
            "wake_check": match.group("wake_check"),
        }
    assert presets, "no preset rows parsed from fos_console.c"
    return presets


@pytest.mark.skipif(not _FOS_CONSOLE_C.is_file(), reason="needs the embedded firmware sources")
def test_console_hardware_preset_table_matches_backend_presets():
    """EMBEDDED_HARDWARE_PRESETS and the `set hardware` table in
    fos_console.c are hand-mirrored copies. A row that drifts is a board the
    cloud flasher provisions differently from the backend — the E1001/E1002
    shipped for weeks with battery sensing in one table and not the other."""
    console = _console_hardware_presets()
    for preset_key, preset in embedded_firmware_module.EMBEDDED_HARDWARE_PRESETS.items():
        platform = preset.get("platform", embedded_firmware_module.SUPPORTED_EMBEDDED_PLATFORM)
        if not str(platform).startswith("esp32"):
            continue  # Pico boards never see the ESP32 console
        assert preset_key in console, f"{preset_key} is missing from the fos_console.c `set hardware` table"
        row = console[preset_key]
        frame = Frame(id=9, embedded={"hardwarePreset": preset_key})
        ensure_embedded_frame_defaults(frame)
        settings = _provisioned(embedded_provisioning_plan(frame))
        assert row["panel"] == settings["panel"], preset_key
        assert row["pins"] == settings["pins"], preset_key
        assert row["gpio_buttons"] == settings.get("gpio_buttons", ""), preset_key
        assert row["assets_sd_pins"] == settings.get("assets_sd_pins", ""), preset_key
        assert row["battery_pin"] == settings.get("battery_pin", "-1"), preset_key
        assert row["battery_divider"] == float(settings.get("battery_divider", "2.0")), preset_key
        assert row["battery_enable_pin"] == settings.get("battery_enable_pin", "-1"), preset_key
        assert row["deep_sleep_on_battery"] == (settings.get("deep_sleep_on_battery") == "1"), preset_key
        if row["deep_sleep_on_battery"]:
            assert row["wake_check"] == settings["wake_check"], preset_key


def test_embedded_hardware_preset_keeps_explicit_gpio_buttons():
    frame = Frame(
        id=8,
        embedded={"hardwarePreset": "waveshare_esp32_s3_photopainter"},
        gpio_buttons=[{"pin": 14, "label": "Custom"}],
    )

    ensure_embedded_frame_defaults(frame)

    assert frame.gpio_buttons == [{"pin": 14, "label": "Custom"}]
    assert embedded_gpio_buttons_for_frame(frame) == [(14, "Custom")]

    no_buttons = Frame(
        id=9,
        embedded={"hardwarePreset": "waveshare_esp32_s3_photopainter"},
        gpio_buttons=[],
    )

    ensure_embedded_frame_defaults(no_buttons)

    assert no_buttons.gpio_buttons == []
    assert embedded_gpio_buttons_for_frame(no_buttons) == []


def test_large_spectra_panel_can_use_thin_client_on_8mb():
    frame = Frame(device="waveshare.EPD_13in3e", device_config={"renderMode": "remote"})
    assert embedded_render_mode_for_frame(frame) == EMBEDDED_RENDER_REMOTE
    check_embedded_panel_fits_memory(frame)


def test_headless_frame_skips_memory_check():
    check_embedded_panel_fits_memory(Frame(device="web_only"))  # must not raise


def test_sd_card_assets_require_all_custom_pins():
    frame = Frame(
        device="waveshare.EPD_7in5_V2",
        device_config={
            "sdCardAssets": {
                "enabled": True,
                "pins": {"cs": 10, "sck": 11, "miso": 12},
            },
        },
    )

    config = embedded_sd_card_assets_for_frame(frame)
    assert config["enabled"] is False
    assert config["pins"] == {"cs": 10, "sck": 11, "miso": 12, "mosi": -1}


def test_embedded_hostname_falls_back_for_ip_hosts():
    assert embedded_hostname_for_frame(Frame(id=12, frame_host="192.168.1.50")) == "frame12"


def _provisioned(plan) -> dict:
    """The plan's `set` commands as a key -> value dict, for assertions that do
    not care about ordering."""
    return {setting["key"]: setting["value"] for setting in plan["settings"]}


def _console_set_keys() -> set[str]:
    """Every key `usb_api set` accepts, parsed from the usage line of cmd_set
    in fos_console.c. The provisioning plan speaks to that parser and nothing
    else: a key the console does not know is a line the board rejects."""
    source = _FOS_CONSOLE_C.read_text(encoding="utf-8")
    usage = re.search(r'printf\("usage: set <(.*?)> <value\.\.\.>', source, re.DOTALL)
    assert usage, "`usage: set <...>` not found in fos_console.c"
    body = re.sub(r'"\s*\n\s*"', "", usage.group(1))
    keys = {key.strip() for key in body.split("|")}
    assert "panel" in keys and "api_key" in keys, keys
    return keys


@pytest.mark.skipif(not _FOS_CONSOLE_C.is_file(), reason="needs the embedded firmware sources")
def test_provisioning_plan_carries_every_setting_the_image_would_bake_in():
    """A stock release image plus these commands IS this frame — that
    equivalence is the whole reason the backend stopped building firmware.

    Order matters twice over: `hardware` applies a whole board bundle that the
    frame's own values must override afterwards, and the admin credentials
    must land before the switch that enables them (the console refuses
    `admin_auth 1` without both)."""
    frame = Frame(
        id=9,
        embedded={"hardwarePreset": "xteink_x4"},
        network={"wifiSSID": "Home WiFi", "wifiPassword": "hunter2"},
        server_host="10.0.0.5",
        server_port=8989,
        server_api_key="key-9",
        interval=600,
        rotate=90,
        scaling_mode="contain",
    )
    ensure_embedded_frame_defaults(frame)

    plan = embedded_provisioning_plan(frame)

    assert plan["supported"] is True
    assert plan["blockers"] == []
    assert plan["platform"] == "esp32-c3"
    assert plan["releasePlatform"] == "esp32-c3-generic"

    assert [setting["key"] for setting in plan["settings"]] == [
        "hardware",          # the board bundle first; everything below overrides it
        "panel",
        "pins",
        "gpio_buttons",
        "backend",
        "api_key",
        "frame_id",
        "hostname",
        "render_mode",
        "interval",
        "rotate",
        "scaling_mode",
        "server_send_logs",
        # max_http_response_bytes only when it differs from the default
        "admin_user",
        "admin_pass",
        "admin_auth",        # after the credentials it switches on
        # assets_sd_pins / assets_sd_freq only for an enabled SD socket
        "assets_sd",
        "battery_pin",
        "battery_divider",
    ]

    settings = _provisioned(plan)
    assert settings["hardware"] == "xteink_x4"
    assert settings["panel"] == "EPD_4in26"
    assert settings["pins"] == "rst=5,dc=4,cs=21,cs2=-1,busy=6,sck=8,mosi=10,pwr=-1"
    assert settings["gpio_buttons"] == "3:POWER"
    assert settings["backend"] == "http://10.0.0.5:8989"
    assert settings["api_key"] == "key-9"
    assert settings["frame_id"] == "9"
    assert settings["hostname"] == "frame9"
    # No PSRAM on the C3, so it can only ever be a thin client.
    assert settings["render_mode"] == "remote"
    assert settings["interval"] == "600"
    assert settings["rotate"] == "90"
    assert settings["scaling_mode"] == "contain"
    assert settings["server_send_logs"] == "1"
    assert settings["admin_user"] == frame.frame_admin_auth["user"]
    assert settings["admin_pass"] == frame.frame_admin_auth["pass"]
    assert settings["admin_auth"] == "1"
    assert settings["assets_sd"] == "0"
    assert plan["wifi"] == {"ssid": "Home WiFi", "password": "hunter2"}

    # Credentials must be flagged so the flasher's log redacts them.
    secrets = {setting["key"] for setting in plan["settings"] if setting["secret"]}
    assert secrets == {"api_key", "admin_pass"}

    # And every key has to be one the device's console actually accepts.
    accepted = _console_set_keys()
    assert set(settings) <= accepted, set(settings) - accepted


@pytest.mark.skipif(not _FOS_CONSOLE_C.is_file(), reason="needs the embedded firmware sources")
def test_provisioning_plan_carries_the_conditional_settings_too():
    """The slots the frame above leaves empty: a non-default HTTP response cap
    and an SD asset socket. Both are keys the console knows, and both land in
    their documented position in the command order."""
    frame = Frame(
        id=9,
        embedded={"hardwarePreset": "waveshare_esp32_s3_photopainter"},
        server_host="host",
        server_api_key="key",
        network={"wifiSSID": "net"},
        max_http_response_bytes=512 * 1024,
        device_config={
            "hardwarePreset": "waveshare_esp32_s3_photopainter",
            "deepSleep": True,
            "deepSleepOnBattery": True,
            "wakeSchedule": True,
            "wakeCheckSeconds": 900,
            "batteryPin": 1,
            "batteryDivider": 2.0,
            "batteryEnablePin": 21,
        },
    )
    ensure_embedded_frame_defaults(frame)

    plan = embedded_provisioning_plan(frame)
    keys = [setting["key"] for setting in plan["settings"]]
    settings = _provisioned(plan)

    assert settings["max_http_response_bytes"] == str(512 * 1024)
    assert keys.index("server_send_logs") < keys.index("max_http_response_bytes")
    assert keys.index("max_http_response_bytes") < keys.index("admin_user")
    assert settings["assets_sd_pins"] == "cs=38,sck=39,miso=40,mosi=41"
    assert settings["assets_sd_freq"] == "20000"
    assert settings["assets_sd"] == "1"
    assert keys.index("assets_sd_freq") < keys.index("assets_sd")
    # Every power key the image used to bake in has a console key too.
    assert settings["deep_sleep"] == "1"
    assert settings["deep_sleep_on_battery"] == "1"
    assert settings["wake_schedule"] == "1"
    assert settings["wake_check"] == "900"
    assert settings["battery_pin"] == "1"
    assert settings["battery_divider"] == "2.0"
    assert settings["battery_enable_pin"] == "21"

    accepted = _console_set_keys()
    assert set(settings) <= accepted, set(settings) - accepted

    # The default cap is never sent: a value the device already has is a
    # console line that can only go wrong.
    frame.max_http_response_bytes = EMBEDDED_DEFAULT_MAX_HTTP_RESPONSE_BYTES
    assert "max_http_response_bytes" not in _provisioned(embedded_provisioning_plan(frame))


def test_provisioning_plan_warns_about_the_published_images_flash_layout():
    """The XTEINK X4 has 16MB, but the published C3 asset is the 4MB no-OTA
    build — it works, it just leaves the rest of the chip and OTA on the table."""
    frame = Frame(id=9, embedded={"hardwarePreset": "xteink_x4"}, server_host="host",
                  server_api_key="key", network={"wifiSSID": "net"})
    ensure_embedded_frame_defaults(frame)

    plan = embedded_provisioning_plan(frame)

    assert plan["supported"] is True
    assert plan["releaseFlashSize"] == "4MB"
    assert any("4MB partition layout" in warning for warning in plan["warnings"])
    assert any("no OTA slot" in warning for warning in plan["warnings"])


def test_provisioning_plan_prefers_the_image_built_for_the_frames_flash_layout():
    """Once the release publishes per-layout images, a 16MB XTEINK X4 is
    flashed with the 16MB OTA layout — the whole chip, and OTA — not the
    generic 4MB image, and neither layout warning applies."""
    frame = Frame(id=9, embedded={"hardwarePreset": "xteink_x4"}, server_host="host",
                  server_api_key="key", network={"wifiSSID": "net"})
    ensure_embedded_frame_defaults(frame)

    plan = embedded_provisioning_plan(frame, published_assets={"esp32-c3-generic", "esp32-c3-16mb"})

    assert plan["releasePlatform"] == "esp32-c3-16mb"
    assert plan["releaseFlashSize"] == "16MB"
    assert not any("partition layout" in warning for warning in plan["warnings"])
    assert not any("no OTA slot" in warning for warning in plan["warnings"])


def test_provisioning_plan_falls_back_to_the_generic_image_without_a_layout_match():
    """An older release (no per-layout images), or no listing at all, keeps
    flashing the generic image with the same warnings as before."""
    frame = Frame(id=9, embedded={"hardwarePreset": "xteink_x4"}, server_host="host",
                  server_api_key="key", network={"wifiSSID": "net"})
    ensure_embedded_frame_defaults(frame)

    for published in ({"esp32-c3-generic", "esp32-s3-generic"}, None):
        plan = embedded_provisioning_plan(frame, published_assets=published)
        assert plan["releasePlatform"] == "esp32-c3-generic"
        assert plan["releaseFlashSize"] == "4MB"
        assert any("4MB partition layout" in warning for warning in plan["warnings"])


def test_provisioning_plan_never_needs_a_listing_for_the_generic_layouts():
    """The generic images ARE the 8MB S3 and 4MB C3 layouts, so a frame on one
    of those resolves to them whatever the release lists."""
    frame = Frame(id=9, device="waveshare.EPD_7in5_V2", server_host="host",
                  server_api_key="key", network={"wifiSSID": "net"})
    ensure_embedded_frame_defaults(frame)

    plan = embedded_provisioning_plan(frame, published_assets=set())

    assert plan["releasePlatform"] == "esp32-s3-generic"
    assert plan["releaseFlashSize"] == "8MB"


def test_release_asset_names_cover_every_flash_layout_once():
    names = embedded_release_asset_names()
    # Generic first: they are the fallback and what the cloud flasher ships.
    assert names[:2] == ["esp32-s3-generic", "esp32-c3-generic"]
    assert len(names) == len(set(names))
    assert set(names) == {
        "esp32-s3-generic",
        "esp32-c3-generic",
        "esp32-s3-4mb",
        "esp32-s3-16mb",
        "esp32-s3-32mb",
        "esp32-c3-8mb",
        "esp32-c3-16mb",
        "esp32-c3-32mb",
    }


def test_provisioning_plan_sends_sd_card_pins_before_enabling_the_socket():
    frame = Frame(
        id=9,
        embedded={"hardwarePreset": "waveshare_esp32_s3_photopainter"},
        server_host="host",
        server_api_key="key",
        network={"wifiSSID": "net"},
        device_config={
            "hardwarePreset": "waveshare_esp32_s3_photopainter",
            "sdCardAssets": {"enabled": True, "pins": {"cs": 38, "sck": 39, "miso": 40, "mosi": 41}},
        },
    )
    ensure_embedded_frame_defaults(frame)

    plan = embedded_provisioning_plan(frame)
    keys = [setting["key"] for setting in plan["settings"]]
    settings = _provisioned(plan)

    assert settings["assets_sd_pins"] == "cs=38,sck=39,miso=40,mosi=41"
    assert settings["assets_sd"] == "1"
    # Enabling the socket before its pins are known would mount the wrong bus.
    assert keys.index("assets_sd_pins") < keys.index("assets_sd")


def test_provisioning_plan_warns_that_tls_arrives_on_the_first_settings_sync():
    """A PEM is kilobytes: it cannot ride a console line. It reaches the board
    through GET /embedded/settings instead, so a TLS frame is provisionable —
    it just answers over plain HTTP until that first poll lands."""
    frame = Frame(
        id=9,
        device="waveshare.EPD_7in5_V2",
        server_host="host",
        server_api_key="key",
        network={"wifiSSID": "net"},
        https_proxy={"enable": True, "certs": {"server": "cert", "server_key": "key"}},
    )
    ensure_embedded_frame_defaults(frame)

    plan = embedded_provisioning_plan(frame)

    assert plan["supported"] is True
    assert plan["blockers"] == []
    assert any("first settings sync" in warning for warning in plan["warnings"])
    # And no TLS console keys are attempted.
    assert "tls_enable" not in _provisioned(plan)


def test_provisioning_plan_provisions_the_device_admin_login():
    """Every embedded frame gets a generated device login. The credentials go
    over the console; the enable switch follows them, because the device
    refuses to turn admin auth on without both."""
    frame = Frame(id=9, device="waveshare.EPD_7in5_V2", server_host="host",
                  server_api_key="key", network={"wifiSSID": "net"})
    ensure_embedded_frame_defaults(frame)

    plan = embedded_provisioning_plan(frame)
    keys = [setting["key"] for setting in plan["settings"]]
    settings = _provisioned(plan)

    assert plan["supported"] is True
    assert settings["admin_user"] == frame.frame_admin_auth["user"]
    assert settings["admin_pass"] == frame.frame_admin_auth["pass"]
    assert settings["admin_auth"] == "1"
    assert keys.index("admin_pass") < keys.index("admin_auth")
    # The password is a credential: the flasher log has to redact it.
    assert next(s for s in plan["settings"] if s["key"] == "admin_pass")["secret"] is True
    assert next(s for s in plan["settings"] if s["key"] == "admin_user")["secret"] is False
    assert not any("admin login" in warning for warning in plan["warnings"])

    # Half a login is no login: the switch goes off and neither half is sent.
    frame.frame_admin_auth = {"enabled": True, "user": "admin", "pass": ""}
    settings = _provisioned(embedded_provisioning_plan(frame))
    assert "admin_user" not in settings
    assert "admin_pass" not in settings
    assert settings["admin_auth"] == "0"


def test_provisioning_plan_blocks_a_frame_with_nowhere_to_call_home():
    """No defaults applied here on purpose: a saved frame always has a server
    API key, but the plan must not hand the device a half-built identity if
    one of these is ever missing."""
    frame = Frame(id=9, device="waveshare.EPD_7in5_V2", server_host="", server_api_key="")

    plan = embedded_provisioning_plan(frame)

    assert plan["supported"] is False
    assert any("no server host" in blocker for blocker in plan["blockers"])
    assert any("no API key" in blocker for blocker in plan["blockers"])
    assert plan["wifi"] is None


def test_provisioning_plan_sets_the_hostname():
    """mDNS name and the device's own web UI host: `set hostname` carries it,
    normalized the same way a per-frame build used to bake it in."""
    frame = Frame(id=9, frame_host="Kitchen Frame.local", device="waveshare.EPD_7in5_V2",
                  server_host="host", server_api_key="key", network={"wifiSSID": "net"})
    ensure_embedded_frame_defaults(frame)

    plan = embedded_provisioning_plan(frame)

    assert plan["supported"] is True
    assert _provisioned(plan)["hostname"] == "kitchen-frame"
    assert embedded_hostname_for_frame(frame) == "kitchen-frame"

    # A frame with no host of its own gets no hostname line at all.
    frame.frame_host = ""
    assert "hostname" not in _provisioned(embedded_provisioning_plan(frame))


@pytest.mark.asyncio
async def test_provisioning_endpoint_returns_the_plan(async_client):
    frame = await create_embedded_frame(async_client)

    # The route consults the cached release listing to pick a layout-matched
    # image; GitHub is not on the test's network.
    from unittest.mock import AsyncMock, patch

    from app.api import firmware_release

    firmware_release.clear_release_cache()
    with patch("app.api.firmware_release._fetch_latest_release", new_callable=AsyncMock, return_value=None):
        response = await async_client.get(f"/api/frames/{frame['id']}/embedded/provisioning")
    firmware_release.clear_release_cache()

    assert response.status_code == 200, response.text
    plan = response.json()["provisioning"]
    assert plan["releasePlatform"] == "esp32-s3-generic"
    assert {setting["key"] for setting in plan["settings"]} >= {"backend", "api_key", "frame_id", "panel"}


@pytest.mark.asyncio
async def test_ssh_agent_endpoints_reject_embedded_frames(async_client, redis):
    frame = await create_embedded_frame(async_client)

    for action in ('reset', 'stop', 'deploy_remote', 'restart_remote', 'clear_build_cache'):
        response = await async_client.post(f"/api/frames/{frame['id']}/{action}")
        assert response.status_code == 400, (action, response.text)

    # Restart and reboot stay available: they run over the device's HTTP API.
    for action in ('restart', 'reboot'):
        response = await async_client.post(f"/api/frames/{frame['id']}/{action}")
        assert response.status_code == 200, (action, response.text)


@pytest.mark.asyncio
async def test_deploy_plan_combined_for_embedded_includes_full_ota_plan(async_client):
    frame = await create_embedded_frame(async_client)

    summary = {"tag": "v2026.9.2", "version": "2026.9.2", "platforms": {"esp32-s3-generic"}}
    with patch("app.api.firmware_release.latest_release_summary",
               new_callable=AsyncMock, return_value=summary):
        response = await async_client.get(f"/api/frames/{frame['id']}/deploy_plan?mode=combined")

    assert response.status_code == 200, response.text
    plan = response.json()['plan']
    assert plan['mode'] == 'combined'
    assert plan['fast_deploy']['action'] == 'http_upload_scenes_reload'
    embedded = plan['full_deploy']['embedded']
    assert embedded['platform'] == 'esp32-s3'
    assert embedded['otaSupported'] is True
    # No build state any more: the plan names the release the device will be
    # offered and the image family it will ask for.
    assert embedded['releasePlatform'] == 'esp32-s3-generic'
    assert embedded['releaseVersion'] == '2026.9.2'
    assert embedded['action'] == 'release_ota_upload_scenes'
    assert 'firmwareStatus' not in embedded
    assert 'needsFirmwareBuild' not in embedded
    assert any('2026.9.2' in note for note in plan['notes'])
    # FullDeployPlanResponse shape stays intact for the drawer
    assert plan['full_deploy']['packages'] == []
    assert plan['full_deploy']['target']['distro'] == 'esp-idf'


@pytest.mark.asyncio
async def test_deploy_plan_for_embedded_survives_an_unreachable_github(async_client):
    """A release lookup this backend cannot make does not block the deploy:
    the device asks for the manifest itself, and may answer up to date."""
    frame = await create_embedded_frame(async_client)

    with patch("app.api.firmware_release.latest_release_summary",
               new_callable=AsyncMock, return_value=None):
        response = await async_client.get(f"/api/frames/{frame['id']}/deploy_plan?mode=combined")

    assert response.status_code == 200, response.text
    plan = response.json()['plan']
    embedded = plan['full_deploy']['embedded']
    assert embedded['releaseVersion'] is None
    # Without a listing the generic image for the chip is still the answer.
    assert embedded['releasePlatform'] == 'esp32-s3-generic'
    assert any('could not be fetched' in note for note in plan['notes'])


@pytest.mark.asyncio
async def test_deploy_plan_full_for_embedded_pico_is_unavailable(async_client, db):
    frame_json = await create_embedded_frame(async_client)
    frame = db.get(Frame, frame_json['id'])
    frame.embedded = {'platform': 'pico-w', 'flashSize': '2MB'}
    db.add(frame)
    db.commit()

    response = await async_client.get(f"/api/frames/{frame.id}/deploy_plan?mode=combined")
    assert response.status_code == 200, response.text
    plan = response.json()['plan']
    assert plan['full_deploy'] is None
    assert any(note.startswith('Full deploy unavailable:') for note in plan['notes'])



# --- The release OTA: asking a board to update itself -----------------------


@pytest.mark.asyncio
async def test_request_embedded_firmware_update_pokes_the_device(async_client, db, redis):
    """The backend holds no image and no signing key. All it does is tell the
    board to check this backend's relay of the release manifest now."""
    frame_json = await create_embedded_frame(async_client)
    frame = db.get(Frame, frame_json['id'])

    with patch('app.tasks.embedded_firmware._fetch_frame_http_bytes', new_callable=AsyncMock) as fetch:
        fetch.return_value = (200, b'{"ok":true}', {'content-type': 'application/json'})
        payload = await request_embedded_firmware_update(db, redis, frame)

    assert payload == {'ok': True}
    fetch.assert_awaited_once()
    assert fetch.await_args.kwargs['path'] == '/api/action/ota'
    assert fetch.await_args.kwargs['method'] == 'POST'

    # A non-JSON body comes back as text, not an exception.
    with patch('app.tasks.embedded_firmware._fetch_frame_http_bytes', new_callable=AsyncMock) as fetch:
        fetch.return_value = (200, b'started', {'content-type': 'text/plain'})
        assert await request_embedded_firmware_update(db, redis, frame) == 'started'


@pytest.mark.asyncio
async def test_request_embedded_firmware_update_reports_device_failures(async_client, db, redis):
    frame_json = await create_embedded_frame(async_client)
    frame = db.get(Frame, frame_json['id'])

    with patch('app.tasks.embedded_firmware._fetch_frame_http_bytes', new_callable=AsyncMock) as fetch:
        fetch.return_value = (503, b'busy rendering', {'content-type': 'text/plain'})
        with pytest.raises(ValueError, match='HTTP 503'):
            await request_embedded_firmware_update(db, redis, frame)

    # A transport failure is the same kind of "no" — never a silent success.
    with patch('app.tasks.embedded_firmware._fetch_frame_http_bytes', new_callable=AsyncMock) as fetch:
        fetch.side_effect = OSError('connection refused')
        with pytest.raises(ValueError, match='connection refused'):
            await request_embedded_firmware_update(db, redis, frame)


@pytest.mark.asyncio
async def test_request_embedded_firmware_update_refuses_a_4mb_board(async_client, db, redis):
    """A 4MB layout has one app slot and no OTA data partition: there is
    nowhere to write an update. That board needs the USB cable."""
    frame_json = await create_embedded_frame(async_client)
    frame = db.get(Frame, frame_json['id'])
    frame.embedded = {**frame.embedded, 'flashSize': '4MB'}
    db.add(frame)
    db.commit()

    with patch('app.tasks.embedded_firmware._fetch_frame_http_bytes', new_callable=AsyncMock) as fetch:
        with pytest.raises(ValueError, match='OTA updates are not available'):
            await request_embedded_firmware_update(db, redis, frame)
    fetch.assert_not_awaited()


@pytest.mark.asyncio
async def test_firmware_ota_route_requests_the_device_update(async_client, db):
    frame = await create_embedded_frame(async_client)

    with patch('app.tasks.embedded_firmware._fetch_frame_http_bytes', new_callable=AsyncMock) as fetch:
        fetch.return_value = (200, b'{"ok":true}', {'content-type': 'application/json'})
        response = await async_client.post(f"/api/frames/{frame['id']}/embedded/firmware/ota")

    assert response.status_code == 200, response.text
    assert response.json() == {'message': 'Firmware update requested', 'device': {'ok': True}}
    fetch.assert_awaited_once()


@pytest.mark.asyncio
async def test_firmware_ota_route_rejects_a_flash_layout_without_ota(async_client, db):
    frame = await create_embedded_frame(async_client)
    stored = db.get(Frame, frame['id'])
    stored.embedded = {**stored.embedded, 'flashSize': '4MB'}
    db.add(stored)
    db.commit()

    response = await async_client.post(f"/api/frames/{frame['id']}/embedded/firmware/ota")
    assert response.status_code == 400
    assert 'OTA updates are not available' in response.json()['detail']


@pytest.mark.asyncio
async def test_pending_commands_are_always_empty(async_client):
    """Cloud parity endpoint (docs/api-triality.md). The cloud answers it from
    a durable queue; the backend pushes every action immediately and queues
    nothing — including the OTA poke, which is now a plain device call — so
    there is never anything here to observe or to take back."""
    frame = await create_embedded_frame(async_client)

    response = await async_client.get(f"/api/frames/{frame['id']}/commands")
    assert response.status_code == 200
    assert response.json() == {'commands': []}

    with patch('app.tasks.embedded_firmware._fetch_frame_http_bytes', new_callable=AsyncMock) as fetch:
        fetch.return_value = (200, b'{"ok":true}', {'content-type': 'application/json'})
        assert (await async_client.post(
            f"/api/frames/{frame['id']}/embedded/firmware/ota")).status_code == 200

    response = await async_client.get(f"/api/frames/{frame['id']}/commands")
    assert response.json() == {'commands': []}

    # Nothing to cancel is a 404, never a pretend success.
    response = await async_client.delete(f"/api/frames/{frame['id']}/commands/anything")
    assert response.status_code == 404
    assert response.json()['detail'] == 'No pending action with that id'
