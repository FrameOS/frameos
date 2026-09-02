import pytest

from app import config as app_config
from app.utils.request_ip import HASSIO_INGRESS_PROXY, extract_client_ip, peer_is_trusted_proxy


@pytest.fixture(autouse=True)
def _no_configured_proxies(monkeypatch):
    monkeypatch.setattr(app_config.config, "FRAMEOS_TRUSTED_PROXIES", "")
    monkeypatch.setattr(app_config.config, "HASSIO_TOKEN", None)


def test_public_peer_cannot_forward_an_address():
    headers = {"x-forwarded-for": "10.0.0.5", "x-real-ip": "10.0.0.6", "forwarded": "for=10.0.0.7"}
    assert extract_client_ip(headers, "8.8.8.8") == "8.8.8.8"
    assert peer_is_trusted_proxy("8.8.8.8") is False


def test_loopback_and_private_peers_are_trusted_by_default():
    assert extract_client_ip({"x-forwarded-for": "203.0.113.9"}, "127.0.0.1") == "203.0.113.9"
    assert extract_client_ip({"x-forwarded-for": "203.0.113.9"}, "192.168.1.20") == "203.0.113.9"
    assert extract_client_ip({"x-real-ip": "203.0.113.10"}, "127.0.0.1") == "203.0.113.10"
    assert extract_client_ip({"forwarded": 'for="[2001:db8::1]:4711"'}, "127.0.0.1") == "2001:db8::1"


def test_rightmost_forwarded_entry_wins():
    # A client-supplied X-Forwarded-For is what the proxy appends to, so the
    # spoofed entry sits on the left and the real peer on the right.
    headers = {"x-forwarded-for": "1.2.3.4, 203.0.113.9"}
    assert extract_client_ip(headers, "127.0.0.1") == "203.0.113.9"


def test_configured_proxies_replace_the_private_range_default(monkeypatch):
    monkeypatch.setattr(app_config.config, "FRAMEOS_TRUSTED_PROXIES", "203.0.113.1, 203.0.113.2")
    assert peer_is_trusted_proxy("203.0.113.1") is True
    assert peer_is_trusted_proxy("127.0.0.1") is False
    assert extract_client_ip({"x-forwarded-for": "198.51.100.7"}, "127.0.0.1") == "127.0.0.1"
    # Chained configured proxies are skipped from the right.
    headers = {"x-forwarded-for": "198.51.100.7, 203.0.113.2"}
    assert extract_client_ip(headers, "203.0.113.1") == "198.51.100.7"


def test_hassio_ingress_proxy_is_trusted_when_running_as_an_addon(monkeypatch):
    monkeypatch.setattr(app_config.config, "FRAMEOS_TRUSTED_PROXIES", "203.0.113.1")
    assert peer_is_trusted_proxy(HASSIO_INGRESS_PROXY) is False
    monkeypatch.setattr(app_config.config, "FRAMEOS_TRUSTED_PROXIES", "")
    monkeypatch.setattr(app_config.config, "HASSIO_TOKEN", "token")
    assert peer_is_trusted_proxy(HASSIO_INGRESS_PROXY) is True


def test_missing_peer_and_missing_headers():
    assert extract_client_ip({}, None) is None
    assert extract_client_ip({}, "127.0.0.1") == "127.0.0.1"
    assert extract_client_ip({"x-forwarded-for": "10.0.0.5"}, None) is None
