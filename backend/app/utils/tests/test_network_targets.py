import ipaddress

import pytest
import pytest_asyncio
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


# DNS rebinding: a name checked once and resolved again by the HTTP client can
# answer the second query with a private address. guarded_transport puts the
# check in the connect itself: the socket only ever goes to an address that
# was just checked. A local server stands in for the "private" target, and
# names that real DNS does not know resolve through the test resolver only,
# so a client that bypassed the guarded backend could not reach it at all.


@pytest_asyncio.fixture
async def local_server():
    import asyncio

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await reader.readuntil(b"\r\n\r\n")
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\ninternal")
        await writer.drain()
        writer.close()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    yield port
    server.close()
    await server.wait_closed()


def _resolve_to(monkeypatch, answers: dict[str, str]):
    async def resolve(host: str):
        literal = network.literal_address(host)
        if literal is not None:
            return [literal]
        if host not in answers:
            raise TargetBlocked(host, "does not resolve")
        return [_ip(answers[host])]

    monkeypatch.setattr(network, "resolve_target", resolve)


@pytest.mark.asyncio
async def test_guarded_transport_refuses_a_private_answer_at_connect(monkeypatch, local_server):
    import httpx

    _resolve_to(monkeypatch, {"rebind.test": "127.0.0.1"})
    transport = network.guarded_transport(allow_private=False, allow_loopback=False)
    async with httpx.AsyncClient(transport=transport) as client:
        with pytest.raises(httpx.ConnectError, match="not allowed"):
            await client.get(f"http://rebind.test:{local_server}/")
        # A literal is checked as itself.
        with pytest.raises(httpx.ConnectError, match="not allowed"):
            await client.get(f"http://127.0.0.1:{local_server}/")


@pytest.mark.asyncio
async def test_guarded_transport_connects_to_the_address_it_checked(monkeypatch, local_server):
    import httpx

    # Loopback allowed, so the checked answer is fine; the connect must use
    # it, since real DNS has never heard of the name.
    _resolve_to(monkeypatch, {"pinned.test": "127.0.0.1"})
    async with httpx.AsyncClient(transport=network.guarded_transport(allow_loopback=True)) as client:
        response = await client.get(f"http://pinned.test:{local_server}/")
    assert response.status_code == 200
    assert response.text == "internal"


@pytest.mark.asyncio
async def test_guarded_transport_trusts_only_its_private_hosts(monkeypatch, local_server):
    import httpx

    _resolve_to(monkeypatch, {"repo.lan": "127.0.0.1", "elsewhere.lan": "127.0.0.1"})
    transport = network.guarded_transport(allow_private=False, allow_loopback=False, private_hosts=["REPO.lan"])
    async with httpx.AsyncClient(transport=transport) as client:
        # Loopback is allowed under TEST for a trusted host (loopback_targets_allowed).
        assert (await client.get(f"http://repo.lan:{local_server}/")).text == "internal"
        with pytest.raises(httpx.ConnectError, match="not allowed"):
            await client.get(f"http://elsewhere.lan:{local_server}/")
