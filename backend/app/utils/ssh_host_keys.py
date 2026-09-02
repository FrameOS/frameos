"""Trust-on-first-use SSH host keys.

The backend used to connect with ``known_hosts=None``: any machine answering
on the frame's address got the SSH password (or a signature from the deploy
key) and then the whole ``frame.json``. Now the host key offered on the
first connect is recorded — on the frame row (``ssh_host_key``) or in the
build host settings (``buildHost.hostKey``) — and every later connect pins
exactly that key. A different key is refused until the owner forgets the
stored one on purpose (Frame settings → SSH → "Forget host key"), which is
what a reinstalled frame needs.
"""
from __future__ import annotations

import base64
import hashlib

import asyncssh


def host_key_fingerprint(openssh_line: str | None) -> str | None:
    """``SHA256:...`` as ``ssh-keygen -l`` prints it, or None for no/invalid key."""
    parts = (openssh_line or "").split()
    if len(parts) < 2:
        return None
    try:
        blob = base64.b64decode(parts[1], validate=True)
    except (ValueError, TypeError):
        return None
    digest = base64.b64encode(hashlib.sha256(blob).digest()).decode("ascii").rstrip("=")
    return f"SHA256:{digest}"


def host_key_type(openssh_line: str | None) -> str | None:
    parts = (openssh_line or "").split()
    return parts[0] if parts else None


def openssh_host_key_line(key: asyncssh.SSHKey) -> str:
    """The ``<type> <base64>`` form of a server host key, as known_hosts stores it."""
    return key.export_public_key("openssh").decode("ascii").strip()


def trusted_known_hosts(openssh_line: str | None):
    """The asyncssh ``known_hosts`` argument: a stored key pins exactly that
    key (any other is refused by asyncssh itself); no stored key means this
    is the first connect and the offered key gets recorded."""
    if not openssh_line:
        return None
    try:
        key = asyncssh.import_public_key(openssh_line)
    except (asyncssh.KeyImportError, ValueError) as exc:
        raise ValueError(f"The stored SSH host key could not be read ({exc})") from exc
    return ([key], [], [])


def host_key_changed_message(target: str, stored_line: str | None, forget_hint: str) -> str:
    stored = host_key_fingerprint(stored_line) or "unknown"
    return (
        f"SSH host key for {target} does not match the key recorded on first connect "
        f"({host_key_type(stored_line) or 'key'} {stored}). Either the machine at this address "
        f"is not the frame that was set up, or it was reinstalled. If it was reinstalled, {forget_hint}."
    )
