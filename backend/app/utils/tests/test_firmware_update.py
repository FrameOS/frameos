"""The fold of a device's firmware-update log lines into the frame row's
`firmware_update` — the same vocabulary the cloud hub writes
(cloud/apps/frame-hub/src/protocol.test.ts has the sibling cases)."""
from datetime import datetime, timezone

from app.utils.firmware_update import (
    firmware_update_from_log,
    firmware_update_is_over,
    is_firmware_update_log,
)

NOW = datetime(2026, 10, 12, 9, 30, 0)


def test_esp32_ota_lines_fold_with_the_version_carried_over():
    downloading = firmware_update_from_log(
        {"event": "ota:backend", "source": "esp32", "status": "downloading", "detail": "2026.10.6"}, None, NOW
    )
    assert downloading == {
        "at": "2026-10-12T09:30:00+00:00",
        "detail": "2026.10.6",
        "plane": "backend",
        "status": "downloading",
        "version": "2026.10.6",
    }
    progress = firmware_update_from_log(
        {"event": "ota:backend", "source": "esp32", "status": "progress", "detail": "1048576/2500000"},
        downloading,
        NOW,
    )
    assert progress["status"] == "progress"
    assert progress["detail"] == "1048576/2500000"
    assert progress["version"] == "2026.10.6"
    verified = firmware_update_from_log(
        {"event": "ota:cloud", "status": "verified", "detail": "rebooting"}, progress, NOW
    )
    assert verified["plane"] == "cloud"
    assert verified["status"] == "verified"
    assert verified["version"] == "2026.10.6"


def test_pi_upgrade_words_map_onto_the_rows_vocabulary():
    scheduled = firmware_update_from_log({"event": "cloud:upgrade", "status": "scheduled"}, None, NOW)
    assert scheduled["status"] == "downloading"
    assert scheduled["version"] is None
    assert scheduled["plane"] == "cloud"
    running = firmware_update_from_log(
        {
            "event": "cloud:upgrade",
            "status": "running",
            "message": "FrameOS upgrade is running.",
            "current_version": "2026.10.4",
            "latest_version": "2026.10.5",
        },
        scheduled,
        NOW,
    )
    assert running["status"] == "downloading"
    assert running["detail"] == "FrameOS upgrade is running."
    assert running["version"] == "2026.10.5"
    assert firmware_update_from_log({"event": "cloud:upgrade", "status": "reboot_required"}, running, NOW)["status"] == "verified"
    assert firmware_update_from_log({"event": "cloud:upgrade", "status": "success"}, running, NOW)["status"] == "verified"
    stalled = firmware_update_from_log(
        {"event": "cloud:upgrade", "status": "stalled", "detail": "the upgrade process stopped reporting"}, running, NOW
    )
    assert stalled["status"] == "error"
    assert stalled["detail"] == "the upgrade process stopped reporting"
    assert stalled["version"] == "2026.10.5"
    assert firmware_update_from_log({"event": "cloud:upgrade", "status": "failed", "message": "boom"}, None, NOW)["status"] == "error"
    assert firmware_update_from_log({"event": "cloud:upgrade", "status": "up_to_date"}, None, NOW)["status"] == "up-to-date"


def test_lines_that_are_not_about_an_update_leave_the_row_alone():
    assert firmware_update_from_log({"event": "render:done"}, None, NOW) is None
    assert firmware_update_from_log({"event": "cloud:upgrade", "status": "idle"}, None, NOW) is None
    assert firmware_update_from_log({"event": "ota:backend"}, None, NOW) is None
    assert firmware_update_from_log("not an object", None, NOW) is None
    assert firmware_update_from_log(["ota:backend"], None, NOW) is None
    assert firmware_update_from_log({"event": "ota:backend", "status": 7}, None, NOW) is None
    assert is_firmware_update_log({"event": "ota:backend", "status": "verified"}) is True
    assert is_firmware_update_log({"event": "log", "message": "ota:backend"}) is False


def test_details_are_capped_and_a_naive_timestamp_is_utc():
    line = firmware_update_from_log(
        {"event": "ota:backend", "status": "error", "detail": "x" * 400}, None, datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc)
    )
    assert len(line["detail"]) == 160
    assert line["at"] == "2026-01-02T03:04:05+00:00"
    assert line["version"] is None


def test_the_boot_after_the_update_closes_the_row():
    verified = {"status": "verified", "version": "2026.10.6"}
    error = {"status": "error", "detail": "download failed", "version": "2026.10.6"}
    assert firmware_update_is_over(verified, None, "2026.10.5") is True
    assert firmware_update_is_over(error, "2026.10.6", "2026.10.5") is True
    # A failure on the version the row already knew stays: it is the one
    # thing worth a word after the reboot.
    assert firmware_update_is_over(error, "2026.10.5", "2026.10.5") is False
    assert firmware_update_is_over(error, None, "2026.10.5") is False
    assert firmware_update_is_over(error, "2026.10.5", None) is True
    assert firmware_update_is_over(None, "2026.10.6", "2026.10.5") is False
