from __future__ import annotations

import asyncio
import ipaddress
import re
import socket
from urllib.parse import urlparse

from fastapi import HTTPException

from app import config as app_config

# Allow plain hostnames (e.g. "frame", "example.com") and IP addresses.
# Reject anything with shell metacharacters, whitespace, or other characters
# that could be used to smuggle flags into subprocesses.
_HOSTNAME_RE = re.compile(
    r"^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$"
)
_FORBIDDEN_CHARS = set("/\\'\"`$|&;()<>{}[]")


def is_safe_host(host: str) -> bool:
    if not host:
        return False

    # ASCII only (avoid unicode lookalikes) and no whitespace
    try:
        host.encode("ascii")
    except UnicodeEncodeError:
        return False
    if any(ch.isspace() for ch in host):
        return False

    if len(host) > 253 or host.startswith("-") or any(ch in _FORBIDDEN_CHARS for ch in host):
        return False

    # IPv4 / IPv6
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        pass

    # Hostname (strip trailing dot if present)
    hostname = host[:-1] if host.endswith(".") else host
    return bool(_HOSTNAME_RE.fullmatch(hostname))


# --------------------------------------------------------------------------
# Outbound target guard (SSRF). `is_safe_host` above is a syntax check; the
# functions below resolve the name and refuse addresses the backend must
# never be talked into reaching on a user's behalf: loopback (its own redis,
# the Supervisor API, itself), link-local (cloud metadata services live at
# 169.254.169.254), multicast, unspecified and reserved ranges. Private
# ranges stay allowed by default — frames, repositories and template hosts
# legitimately live on the LAN — and the live-preview proxy passes
# `allow_private=False` because it is a general-purpose HTTP relay.
#
# DNS is resolved once, here; a rebind between the check and the connect is
# a residual risk accepted for project-authenticated features. Frame hosts
# are IP literals in practice, which have no such window.
# --------------------------------------------------------------------------


class TargetBlocked(Exception):
    def __init__(self, host: str, reason: str) -> None:
        super().__init__(f"{host}: {reason}")
        self.host = host
        self.reason = reason


def loopback_targets_allowed() -> bool:
    """Loopback frames are a development and e2e convenience (the runtime and
    the backend on one machine); production installs never need them."""
    cfg = app_config.config
    if getattr(cfg, "TEST", False):
        return True
    return str(getattr(cfg, "FRAMEOS_ALLOW_LOOPBACK_TARGETS", "") or "").strip().lower() in ("1", "true", "yes")


def address_block_reason(
    address: ipaddress.IPv4Address | ipaddress.IPv6Address,
    *,
    allow_private: bool = True,
    allow_loopback: bool | None = None,
) -> str | None:
    """Why `address` must not be contacted, or None when it may be."""
    if allow_loopback is None:
        allow_loopback = loopback_targets_allowed()
    mapped = getattr(address, "ipv4_mapped", None)
    if mapped is not None:
        return address_block_reason(mapped, allow_private=allow_private, allow_loopback=allow_loopback)
    if address.is_loopback:
        return None if allow_loopback else "loopback address"
    if address.is_unspecified:
        return "unspecified address"
    if address.is_link_local:
        return "link-local address"
    if address.is_multicast:
        return "multicast address"
    if address.is_reserved:
        return "reserved address"
    if address.is_private and not allow_private:
        return "private-network address"
    return None


def literal_address(host: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    bare = host.strip()
    if bare.startswith("[") and bare.endswith("]"):
        bare = bare[1:-1]
    try:
        return ipaddress.ip_address(bare)
    except ValueError:
        return None


async def resolve_target(host: str) -> list[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    """Every address `host` resolves to (a literal resolves to itself).
    The test suite swaps this for a resolver that maps its fictional host
    names to a public address (app/conftest.py)."""
    return await resolve_target_dns(host)


async def resolve_target_dns(host: str) -> list[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    bare = host.strip()
    if bare.startswith("[") and bare.endswith("]"):
        bare = bare[1:-1]
    try:
        return [ipaddress.ip_address(bare)]
    except ValueError:
        pass
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(bare, None, type=socket.SOCK_STREAM)
    except (OSError, UnicodeError) as exc:
        raise TargetBlocked(host, f"does not resolve ({exc})") from exc
    addresses = []
    for info in infos:
        raw = str(info[4][0]).split("%", 1)[0]
        try:
            address = ipaddress.ip_address(raw)
        except ValueError as exc:
            raise TargetBlocked(host, f"resolved to an unusable address ({raw})") from exc
        if address not in addresses:
            addresses.append(address)
    if not addresses:
        raise TargetBlocked(host, "does not resolve")
    return addresses


async def check_target_host(host: str, *, allow_private: bool = True, allow_loopback: bool | None = None) -> None:
    """Raise TargetBlocked unless every address `host` resolves to may be contacted."""
    if not host or not is_safe_host(host.strip("[]")):
        raise TargetBlocked(host or "", "not a valid host name or address")
    for address in await resolve_target(host):
        reason = address_block_reason(address, allow_private=allow_private, allow_loopback=allow_loopback)
        if reason:
            raise TargetBlocked(host, f"resolves to a {reason} ({address})")


async def assert_target_allowed(host: str, *, allow_private: bool = True, what: str = "Target host") -> None:
    """`check_target_host` as a 403 for API routes."""
    try:
        await check_target_host(host, allow_private=allow_private)
    except TargetBlocked as exc:
        raise HTTPException(status_code=403, detail=f"{what} is not allowed: {exc}") from exc


async def assert_url_target_allowed(url: str, *, allow_private: bool = True, what: str = "URL") -> str:
    """Scheme + resolved-host check for a URL the backend is about to fetch;
    returns the hostname."""
    parsed = urlparse((url or "").strip())
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise HTTPException(status_code=400, detail=f"{what} must be an http(s) URL")
    await assert_target_allowed(parsed.hostname, allow_private=allow_private, what=f"{what} host")
    return parsed.hostname
