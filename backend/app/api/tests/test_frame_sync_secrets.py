"""Write-only secrets on the device side of frame sync.

The ESP32 serves "" for its admin password, TLS private key, backend API key
and Wi-Fi passphrase (embedded/esp32/main/fos_http.c): they are accepted on
POST and never read back. The backend must read that "" as "unchanged" —
neither a diff to show nor a value to import — or a routine sync would blank
the backend's copy and the next deploy would push the blank to the device.
"""

from app.api.frame_sync import (
    FRAME_SYNC_BACKEND_OWNED_KEYS,
    FRAME_SYNC_FRAME_KEYS,
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


def test_blanked_secret_leaves_are_not_sync_choices_at_all():
    # Every leaf the device blanks (admin password, TLS key, API key, Wi-Fi
    # passphrase) is either backend-owned and never pulled
    # (FRAME_SYNC_BACKEND_OWNED_KEYS), outside the pull list, or dropped by the
    # per-key compaction — so even the raw, un-restored payload shows nothing to
    # choose. The restore helper is what keeps the backend's copy intact when
    # such a payload is written back; the two tests above cover that.
    backend = _backend_frame()
    section = _build_frame_sync_section(backend, _device_frame(), backend)
    assert section["changes"] == []


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


def test_backend_owned_keys_are_never_pulled_from_the_device():
    # A device that claims another control mode, a Remote that may run
    # commands under a secret of its choosing, or a different admin login
    # must never even appear as a sync choice.
    for key in ("mode", "agent", "frame_admin_auth"):
        assert key in FRAME_SYNC_BACKEND_OWNED_KEYS
        assert key not in FRAME_SYNC_FRAME_KEYS
    backend = _backend_frame()
    backend["mode"] = "rpios"
    backend["agent"] = {"agentEnabled": True, "agentRunCommands": False, "agentSharedSecret": "ours"}
    device = _device_frame()
    device["mode"] = "buildroot"
    device["agent"] = {"agentEnabled": True, "agentRunCommands": True, "agentSharedSecret": "theirs"}
    device["frame_admin_auth"] = {"enabled": False, "user": "root", "pass": "pwned"}
    section = _build_frame_sync_section(backend, device)
    paths = {change["path"] for change in section.get("changes", [])}
    assert not paths & {"mode", "agent", "frame_admin_auth"}


def test_https_proxy_sync_carries_no_certificate_material():
    # The backend mints and pushes the pair; the device's copy is not a
    # source, and a cert imported without its blanked key would mismatch.
    value = _sync_frame_value("https_proxy", _device_frame()["https_proxy"])
    assert value == {"enable": True, "port": 8443, "expose_only_port": True}


def test_a_withheld_auto_update_channel_never_reads_as_drift():
    # A Pi with a legacy compiled scene is told "off" (frame.json withholds
    # the channel — get_frame_json / effective_auto_update) even though the
    # row keeps its preference. Comparing the preference against the
    # device's copy pinned "Automatic updates: stable → off" into the drawer.
    backend = _backend_frame()
    backend["mode"] = "rpios"
    backend["auto_update"] = "stable"
    backend["scenes"] = [{"id": "s1", "settings": {"execution": "compiled"}, "nodes": [], "edges": []}]
    device = _device_frame()
    device["auto_update"] = "off"
    section = _build_frame_sync_section(backend, device, backend)
    assert [change["path"] for change in section["changes"] if change["path"] == "auto_update"] == []

    # The same frame on interpreted scenes: the preference reaches the
    # device, and a device on another channel is a real difference.
    backend["scenes"] = []
    section = _build_frame_sync_section(backend, device, backend)
    assert [change["path"] for change in section["changes"] if change["path"] == "auto_update"] == ["auto_update"]


def test_a_device_that_reports_no_channel_is_not_a_choice():
    # Firmware before 2026.9.12 answers without auto_update; the backend's
    # "stable" is not drift against an absence.
    backend = _backend_frame()
    backend["auto_update"] = "stable"
    section = _build_frame_sync_section(backend, _device_frame(), backend)
    assert section["changes"] == []
