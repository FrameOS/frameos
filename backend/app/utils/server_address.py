"""The address a frame reaches this backend on — one reading on every plane.

Stored as three fields (`server_host`, a bare host; `server_port`;
`server_scheme`), typed as one (`https://host:8443`, `host:8989`, `host`).
`docs/server-address-fixtures.json` is the contract: the Nim runtime
(`frameos/src/frameos/types.nim`) and the SPA (`utils/backendAddress.ts`)
replay the same cases, so a typed address means the same thing in the
add-frame form, the frame settings, the Wi-Fi portal and frame.json.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Optional

_SCHEME_PREFIX = re.compile(r"^([a-z][a-z0-9+.-]*)://", re.IGNORECASE)


def scheme_from_port(port: Optional[int]) -> str:
    """The seed for a row or frame.json that predates `server_scheme`
    (2026.9.13): a port ending in 443 meant TLS. The frame's rule, so a
    frame.json written before the key and the row that described it agree."""
    try:
        return "https" if int(port or 0) % 1000 == 443 else "http"
    except (TypeError, ValueError):
        return "http"


def normalize_scheme(value: Any, port: Optional[int] = None) -> str:
    """'http' | 'https' from a stored value (`HTTPS://` tolerated), else the
    seed from the port — never a third value."""
    scheme = str(value or "").strip().lower().rstrip(":/")
    if scheme in ("http", "https"):
        return scheme
    return scheme_from_port(port)


@dataclass(frozen=True)
class ServerAddress:
    """A typed address, split. `scheme` is '' and `port` None when the text
    did not say; the consumer fills them (the row's defaults, the detected
    scheme). A non-numeric port and a scheme other than http(s) stay in
    `host`, so the host check refuses the whole thing instead of half."""

    scheme: str
    host: str
    port: Optional[int]

    @property
    def said_scheme(self) -> bool:
        return self.scheme != ""


def split_address(value: Any) -> ServerAddress:
    text = str(value or "").strip()
    scheme = ""
    match = _SCHEME_PREFIX.match(text)
    if match:
        if match.group(1).lower() in ("http", "https"):
            scheme = match.group(1).lower()
            text = text[match.end():]
        else:
            return ServerAddress("", text, None)
    text = text.split("/", 1)[0].strip()
    if text.startswith("["):
        closing = text.find("]")
        if closing > 0:
            host, rest = text[: closing + 1], text[closing + 1 :]
            if rest == "":
                return ServerAddress(scheme, host, None)
            if rest.startswith(":") and rest[1:].isdigit():
                return ServerAddress(scheme, host, int(rest[1:]))
        return ServerAddress(scheme, text, None)
    if text.count(":") == 1:
        host, _, port_text = text.partition(":")
        if port_text == "":
            return ServerAddress(scheme, host, None)
        if port_text.isdigit():
            return ServerAddress(scheme, host, int(port_text))
    return ServerAddress(scheme, text, None)


def default_port_for(scheme: str) -> int:
    """What a typed address without a port means: the scheme's own port when
    one was said, else the backend's 8989."""
    return {"https": 443, "http": 80}.get(scheme, 8989)


def join_address(scheme: str, host: str, port: Optional[int]) -> str:
    """`scheme://host[:port]`, the port left off when it is the scheme's own.
    An IPv6 literal gets its brackets."""
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    port_value = int(port or 0)
    if port_value <= 0 or port_value == default_port_for(scheme):
        return f"{scheme}://{host}"
    return f"{scheme}://{host}:{port_value}"
