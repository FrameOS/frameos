"""The processor speed in the device sync compare: device_config.cpuMode on
the backend, deviceConfig.cpuMode in frame.json (app/utils/cpu_mode.py)."""
from app.api import frame_sync
from app.models.frame import serialize_device_config


def test_the_deployed_speed_echoes_back_as_no_change():
    backend = {"device_config": {"cpuMode": "performance"}}
    # What the frame's admin API reads back: frame.json's deviceConfig as the
    # deploy wrote it.
    device = {"device_config": serialize_device_config(backend["device_config"])}
    section = frame_sync._build_frame_sync_section(backend, device, backend)
    assert section["changes"] == []


def test_a_speed_set_on_the_frame_is_a_device_config_change():
    backend = {"device_config": {"cpuMode": "performance"}}
    device = {"device_config": {"cpuMode": "battery"}}
    section = frame_sync._build_frame_sync_section(backend, device, backend)
    assert [change["path"] for change in section["changes"]] == ["device_config"]


def test_the_deploys_carry_it():
    # SSH deploys write serialize_device_config's deviceConfig; the admin-API
    # deploy sends the sync value of device_config, which keeps it.
    assert serialize_device_config({"cpu_mode": "battery"})["cpuMode"] == "battery"
    assert "cpuMode" not in serialize_device_config({"cpuMode": "turbo"})
    assert frame_sync._sync_frame_value("device_config", {"cpuMode": "battery"}) == {"cpuMode": "battery"}
