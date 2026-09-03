import ipaddress
from typing import Any, Mapping, Optional

from app import config as app_config

# The Home Assistant Supervisor's ingress proxy. When the backend runs as an
# add-on (HASSIO_TOKEN is set) this is the only peer that ever fronts a user.
HASSIO_INGRESS_PROXY = "172.30.32.2"


def configured_trusted_proxies() -> list[str]:
    return [p.strip() for p in app_config.config.FRAMEOS_TRUSTED_PROXIES.split(",") if p.strip()]


def peer_is_trusted_proxy(peer: Optional[str]) -> bool:
    """Whether a direct peer may set X-Forwarded-* / Forwarded / X-Real-IP.

    Configured proxies win. Otherwise trust loopback and private-range peers:
    that covers docker and the usual reverse-proxy layouts, while a client out
    on the network cannot claim another address (or origin) by sending a header.
    """
    peer = peer or ""
    if not peer:
        return False
    configured = configured_trusted_proxies()
    if configured:
        return peer in configured
    if app_config.config.HASSIO_TOKEN and peer == HASSIO_INGRESS_PROXY:
        return True
    try:
        address = ipaddress.ip_address(peer)
    except ValueError:
        return False
    return address.is_loopback or address.is_private


def _forwarded_for_chain(headers: Mapping[str, str]) -> list[str]:
    chain: list[str] = []
    forwarded_for = headers.get("x-forwarded-for")
    if forwarded_for:
        chain = [part.strip() for part in forwarded_for.split(",") if part.strip()]
    if chain:
        return chain

    forwarded = headers.get("forwarded")
    if forwarded:
        for entry in forwarded.split(","):
            for directive in entry.split(";"):
                key, _, value = directive.strip().partition("=")
                if key.lower() == "for" and value:
                    cleaned = value.strip().strip('"')
                    if cleaned.startswith("[") and "]" in cleaned:
                        cleaned = cleaned[1:cleaned.index("]")]
                    if cleaned:
                        chain.append(cleaned)
    if chain:
        return chain

    real_ip = headers.get("x-real-ip")
    if real_ip and real_ip.strip():
        return [real_ip.strip()]
    return []


def extract_client_ip(
    headers: Mapping[str, str],
    client_host: Optional[str] = None,
) -> Optional[str]:
    """The address a request really came from.

    Forwarded headers are honoured only when the socket peer is a trusted proxy;
    anyone else gets their socket address back whatever they send. Proxies
    append the peer they saw, so the trustworthy entry is the rightmost one that
    is not itself a configured proxy — the leftmost is whatever the client
    typed.
    """
    if not peer_is_trusted_proxy(client_host):
        return client_host
    chain = _forwarded_for_chain(headers)
    if not chain:
        return client_host
    configured = set(configured_trusted_proxies())
    for candidate in reversed(chain):
        if candidate not in configured:
            return candidate
    return chain[0]


def client_ip_for_request(request: Any) -> Optional[str]:
    """`extract_client_ip` for a Starlette Request or WebSocket."""
    client_host = request.client.host if request.client else None
    return extract_client_ip(request.headers, client_host)
