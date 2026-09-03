"""Write-only secrets on the device side of frame sync.

The ESP32 serves "" for its admin password, TLS private key, backend API key
and Wi-Fi passphrase (embedded/esp32/main/fos_http.c): they are accepted on
POST and never read back. The backend must read that "" as "unchanged" —
neither a diff to show nor a value to import — or a routine sync would blank
the backend's copy and the next deploy would push the blank to the device.
"""

from app.api.frame_sync import (
    _build_frame_sync_section,
    _restore_write_only_secrets,
    _sync_frame_value,
)
from app.models.frame import Frame


def _backend_frame() -> dict:
    return {
        "server_api_key": "backend-api-key",
        "frame_access_key": "access-key",
        "ssh_pass": "ssh-secret",
        "frame_admin_auth": {"enabled": True, "user": "admin", "pass": "admin-secret"},
        "https_proxy": {
            "enable": True,
            "port": 8443,
            "expose_only_port": True,
            "certs": {"server": "CERT", "server_key": "KEY", "client_ca": ""},
        },
        "network": {"wifiSSID": "home", "wifiPassword": "wifi-secret", "wifiHotspot": "disabled"},
        "interval": 300,
    }


def _device_frame() -> dict:
    # What the ESP32 answers: the same shape with every secret leaf blanked.
    return {
        "server_api_key": "",
        "frame_access_key": "",
        "ssh_pass": "",
        "frame_admin_auth": {"enabled": True, "user": "admin", "pass": ""},
        "https_proxy": {
            "enable": True,
            "port": 8443,
            "expose_only_port": True,
            "certs": {"server": "CERT", "server_key": "", "client_ca": ""},
        },
        "network": {"wifiSSID": "home", "wifiPassword": "", "wifiHotspot": "disabled"},
        "interval": 300,
    }


def test_blank_device_secrets_are_filled_from_the_backend_copy():
    restored = _restore_write_only_secrets(_device_frame(), _backend_frame())
    assert restored["server_api_key"] == "backend-api-key"
    assert restored["frame_access_key"] == "access-key"
    assert restored["ssh_pass"] == "ssh-secret"
    assert restored["frame_admin_auth"]["pass"] == "admin-secret"
    assert restored["https_proxy"]["certs"]["server_key"] == "KEY"
    assert restored["network"]["wifiPassword"] == "wifi-secret"
    # Non-secret leaves are the device's own.
    assert restored["frame_admin_auth"]["user"] == "admin"
    assert restored["https_proxy"]["certs"]["server"] == "CERT"


def test_a_secret_the_device_does_report_wins_over_the_backend_copy():
    device = _device_frame()
    device["frame_admin_auth"]["pass"] = "device-set-secret"
    restored = _restore_write_only_secrets(device, _backend_frame())
    assert restored["frame_admin_auth"]["pass"] == "device-set-secret"


def test_a_blank_on_both_sides_stays_blank():
    backend = _backend_frame()
    backend["https_proxy"]["certs"]["server_key"] = ""
    restored = _restore_write_only_secrets(_device_frame(), backend)
    assert restored["https_proxy"]["certs"]["server_key"] == ""


def test_restore_copes_with_missing_or_foreign_shapes():
    # A device without the section, or with a non-dict where a dict is
    # expected, must not raise and must not invent structure.
    device = {"frame_admin_auth": "nope", "interval": 10}
    restored = _restore_write_only_secrets(device, _backend_frame())
    assert restored["frame_admin_auth"] == "nope"
    assert "https_proxy" not in restored


def test_blanked_secrets_do_not_show_as_changes_once_restored():
    backend = _backend_frame()
    device = _restore_write_only_secrets(_device_frame(), backend)
    section = _build_frame_sync_section(backend, device, backend)
    assert section["has_changes"] is False
    assert section["changes"] == []


def test_without_restore_the_blanks_would_read_as_changes():
    # The guard the test above depends on: the raw payload really differs.
    backend = _backend_frame()
    section = _build_frame_sync_section(backend, _device_frame(), backend)
    paths = {change["path"] for change in section["changes"]}
    assert "frame_admin_auth" in paths
    assert "https_proxy" in paths
    assert _sync_frame_value("frame_admin_auth", _device_frame()["frame_admin_auth"]) != _sync_frame_value(
        "frame_admin_auth", backend["frame_admin_auth"]
    )


def test_restore_reads_the_backend_copy_off_a_frame_row():
    frame = Frame(
        name="esp",
        frame_host="10.0.0.5",
        frame_port=80,
        server_host="backend.local",
        server_port=8989,
        server_api_key="row-api-key",
        frame_admin_auth={"enabled": True, "user": "admin", "pass": "row-admin-secret"},
        https_proxy={"enable": True, "certs": {"server": "CERT", "server_key": "ROW-KEY"}},
        network={"wifiSSID": "home", "wifiPassword": "row-wifi-secret"},
        mode="embedded",
    )
    restored = _restore_write_only_secrets(_device_frame(), frame)
    assert restored["server_api_key"] == "row-api-key"
    assert restored["frame_admin_auth"]["pass"] == "row-admin-secret"
    assert restored["https_proxy"]["certs"]["server_key"] == "ROW-KEY"
    assert restored["network"]["wifiPassword"] == "row-wifi-secret"
