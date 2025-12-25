from __future__ import annotations

import ipaddress
import re

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
