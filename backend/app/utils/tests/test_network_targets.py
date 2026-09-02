import ipaddress

import pytest
from fastapi import HTTPException

from app.utils import network
from app.utils.network import (
    TargetBlocked,
    address_block_reason,
    assert_target_allowed,
    assert_url_target_allowed,
    check_target_host,
)


def _ip(value: str):
    return ipaddress.ip_address(value)


def test_address_block_reasons():
    assert address_block_reason(_ip("192.168.1.20")) is None  # frames live here
    assert address_block_reason(_ip("10.0.0.1")) is None
    assert address_block_reason(_ip("93.184.216.34")) is None
    assert "loopback" in address_block_reason(_ip("127.0.0.1"), allow_loopback=False)
    assert "loopback" in address_block_reason(_ip("::1"), allow_loopback=False)
    assert address_block_reason(_ip("127.0.0.1"), allow_loopback=True) is None
    assert "link-local" in address_block_reason(_ip("169.254.169.254"))  # cloud metadata
    assert "link-local" in address_block_reason(_ip("fe80::1"))
    assert "multicast" in address_block_reason(_ip("224.0.0.1"))
    assert "unspecified" in address_block_reason(_ip("0.0.0.0"))
    assert "private" in address_block_reason(_ip("192.168.1.20"), allow_private=False)
    # IPv4-mapped IPv6 is judged as the IPv4 it wraps.
    assert "link-local" in address_block_reason(_ip("::ffff:169.254.169.254"))
    assert "loopback" in address_block_reason(_ip("::ffff:127.0.0.1"), allow_loopback=False)


@pytest.mark.asyncio
async def test_literals_are_checked_without_dns():
    await check_target_host("192.168.1.20")
    await check_target_host("[fd00::5]")
    with pytest.raises(TargetBlocked):
        await check_target_host("169.254.169.254")
    with pytest.raises(TargetBlocked):
        await check_target_host("127.0.0.1", allow_loopback=False)
    with pytest.raises(TargetBlocked):
        await check_target_host("192.168.1.20", allow_private=False)
    with pytest.raises(TargetBlocked):
        await check_target_host("not a host")
    with pytest.raises(TargetBlocked):
        await check_target_host("")


@pytest.mark.asyncio
async def test_names_are_resolved_and_every_address_must_pass(monkeypatch):
    async def fake_resolve(host):
        return {
            "frame.lan": [_ip("192.168.1.20")],
            "sneaky.example": [_ip("93.184.216.34"), _ip("169.254.169.254")],
        }[host]

    monkeypatch.setattr(network, "resolve_target", fake_resolve)
    await check_target_host("frame.lan")
    with pytest.raises(TargetBlocked) as excinfo:
        await check_target_host("sneaky.example")
    assert "169.254.169.254" in str(excinfo.value)


@pytest.mark.asyncio
async def test_unresolvable_names_are_blocked(monkeypatch):
    monkeypatch.setattr(network, "resolve_target", network.resolve_target_dns)
    with pytest.raises(TargetBlocked):
        await check_target_host("definitely-not-a-real-host.invalid")


@pytest.mark.asyncio
async def test_loopback_is_allowed_under_test_and_by_env(monkeypatch):
    # conftest runs with TEST=True: loopback frames (e2e, local dev) work.
    await check_target_host("127.0.0.1")
    monkeypatch.setattr(network.app_config.config, "TEST", False)
    monkeypatch.setattr(network.app_config.config, "FRAMEOS_ALLOW_LOOPBACK_TARGETS", "")
    with pytest.raises(TargetBlocked):
        await check_target_host("127.0.0.1")
    monkeypatch.setattr(network.app_config.config, "FRAMEOS_ALLOW_LOOPBACK_TARGETS", "1")
    await check_target_host("127.0.0.1")


@pytest.mark.asyncio
async def test_api_helpers_turn_a_block_into_403():
    with pytest.raises(HTTPException) as excinfo:
        await assert_target_allowed("169.254.169.254", what="Frame host")
    assert excinfo.value.status_code == 403
    assert "Frame host" in excinfo.value.detail
    assert await assert_url_target_allowed("http://192.168.1.20:8787/repo.json") == "192.168.1.20"
    with pytest.raises(HTTPException) as excinfo:
        await assert_url_target_allowed("ftp://192.168.1.20/x")
    assert excinfo.value.status_code == 400
    with pytest.raises(HTTPException) as excinfo:
        await assert_url_target_allowed("http://169.254.169.254/latest/meta-data")
    assert excinfo.value.status_code == 403
