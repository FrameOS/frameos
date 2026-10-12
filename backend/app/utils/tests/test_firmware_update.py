"""The fold of a device's firmware-update log lines into the frame row's
`firmware_update` — the same vocabulary the cloud hub writes
(cloud/apps/frame-hub/src/protocol.test.ts has the sibling cases)."""
from datetime import datetime, timezone

from app.utils.firmware_update import (
    LEAVE,
    firmware_update_after_boot,
    firmware_update_already_applied,
    firmware_update_done,
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


def test_a_verified_line_for_the_version_the_frame_already_runs_is_over_on_arrival():
    # The Pi's watcher reports `success` from the new runtime, after the
    # bootup that cleared the row; folded as-is the row said "rebooting
    # into 2026.10.6" for a frame already running it.
    verified = firmware_update_from_log(
        {"event": "cloud:upgrade", "status": "success", "latest_version": "2026.10.6"}, None, NOW
    )
    assert firmware_update_already_applied(verified, "2026.10.6") is True
    assert firmware_update_already_applied(verified, "2026.10.5") is False
    assert firmware_update_already_applied(verified, None) is False
    running = firmware_update_from_log(
        {"event": "cloud:upgrade", "status": "running", "latest_version": "2026.10.6"}, None, NOW
    )
    assert firmware_update_already_applied(running, "2026.10.6") is False
    assert firmware_update_already_applied(None, "2026.10.6") is False


def test_a_boot_on_the_old_version_mid_download_is_the_failure_the_device_could_not_report():
    # E1004, 2026-10-12: the download died while the frame's socket was down,
    # so its `ota:cloud error` never arrived; the next boot (a deep-sleep wake)
    # reported the old version and the row still said "progress".
    progress = {"status": "progress", "detail": "1048576/3233648", "plane": "cloud", "version": "2026.10.8"}
    boot = {"event": "bootup", "source": "esp32", "version": "2026.10.6", "mode": "embedded"}
    folded = firmware_update_from_log(boot, progress, NOW)
    assert folded is not None
    assert folded["status"] == "error"
    assert folded["plane"] == "cloud"
    assert folded["version"] == "2026.10.8"
    assert folded["detail"] == "interrupted: the frame restarted on 2026.10.6 before the update finished"
    # The boot that follows a success is the hello's/bootup branch's business
    # (firmware_update_is_over), not an interruption.
    assert firmware_update_from_log({"event": "bootup", "version": "v2026.10.8"}, progress, NOW) is None
    # A download still waiting for the frame's render pass is interruptible too.
    waiting = {"status": "waiting", "detail": "render", "plane": "cloud", "version": "2026.10.8"}
    assert firmware_update_from_log(boot, waiting, NOW)["status"] == "error"
    # Only a running download is interruptible: a failure, a verified
    # install or an empty row stay as they are.
    for row in (
        {"status": "error", "detail": "signature-rejected", "version": "2026.10.8"},
        {"status": "verified", "version": "2026.10.8"},
        {"status": "up-to-date"},
        None,
    ):
        assert firmware_update_from_log(boot, row, NOW) is None
    # A Pi row from the "scheduled" line names no version yet: a boot on
    # any version while it says downloading is still an interruption.
    scheduled = {"status": "downloading", "detail": "", "plane": "cloud", "version": None}
    pi_boot = firmware_update_from_log({"event": "bootup", "version": "2026.10.6"}, scheduled, NOW)
    assert pi_boot is not None
    assert pi_boot["status"] == "error"
    assert pi_boot["version"] is None
    assert firmware_update_from_log({"event": "bootup"}, progress, NOW) is None
    assert is_firmware_update_log(boot) is False


def test_the_boot_that_ends_an_update_leaves_a_done_row():
    progress = {"status": "progress", "detail": "3148784/3233648", "plane": "cloud", "version": "2026.10.8", "at": "x"}
    # Still downloading on the same version: leave it (the bootup rule in
    # firmware_update_from_log is what calls this an interruption).
    assert firmware_update_after_boot(progress, "2026.10.6", "2026.10.6", NOW) is LEAVE
    done = firmware_update_after_boot(progress, "2026.10.8", "2026.10.6", NOW)
    assert done == {
        "at": "2026-10-12T09:30:00+00:00",
        "detail": "",
        "plane": "cloud",
        "status": "done",
        "version": "2026.10.8",
    }
    # A verified row keeps the device's closing sentence; no version in the
    # boot line keeps the one the update named.
    verified = {"status": "verified", "detail": "FrameOS upgraded to 2026.10.8. Rebooting.", "version": "2026.10.8", "plane": "cloud"}
    assert firmware_update_after_boot(verified, None, "2026.10.6", NOW) == {
        "at": "2026-10-12T09:30:00+00:00",
        "detail": "FrameOS upgraded to 2026.10.8. Rebooting.",
        "plane": "cloud",
        "status": "done",
        "version": "2026.10.8",
    }
    # A failure the frame outgrew is a success the plane missed.
    error = {"status": "error", "detail": "download-failed", "version": "2026.10.8", "plane": "backend"}
    assert firmware_update_after_boot(error, "2026.10.8", "2026.10.6", NOW)["status"] == "done"
    assert firmware_update_after_boot(error, "2026.10.6", "2026.10.6", NOW) is LEAVE
    # Rows that never narrated an update clear on a new version; a done row
    # on the same version stays.
    assert firmware_update_after_boot({"status": "up-to-date"}, "2026.10.8", "2026.10.6", NOW) is None
    assert firmware_update_after_boot({"status": "done", "version": "2026.10.8"}, "2026.10.8", "2026.10.8", NOW) is LEAVE
    assert firmware_update_after_boot(None, "2026.10.8", "2026.10.6", NOW) is LEAVE
    assert firmware_update_done({"status": "verified", "detail": "x", "version": "2026.10.8"}) == {
        "status": "done",
        "detail": "x",
        "version": "2026.10.8",
    }
