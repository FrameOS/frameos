import pytest

from app.utils.network import is_safe_host


@pytest.mark.parametrize(
    "host",
    [
        "example.com",
        "frame",
        "FRAME-01.local",
        "192.168.1.5",
        "2001:db8::1",
        "localhost",
    ],
)
def test_safe_hosts(host: str):
    assert is_safe_host(host)


@pytest.mark.parametrize(
    "host",
    [
        "-example.com",
        "example.com;rm -rf /",
        "example.com && echo test",
        "bad host",
        "example.com\n",
        "example..com",
        "example/.com",
        "127.0.0.1 ",
        "[::1]",
        "foo|bar",
    ],
)
def test_unsafe_hosts(host: str):
    assert not is_safe_host(host)
