import asyncssh
import pytest

from app.utils.ssh_host_keys import (
    host_key_changed_message,
    host_key_fingerprint,
    host_key_type,
    openssh_host_key_line,
    trusted_known_hosts,
)


def _key_line() -> str:
    return openssh_host_key_line(asyncssh.generate_private_key("ssh-ed25519").convert_to_public())


def test_fingerprint_matches_ssh_keygen_format():
    line = _key_line()
    fingerprint = host_key_fingerprint(line)
    assert fingerprint and fingerprint.startswith("SHA256:") and "=" not in fingerprint
    assert host_key_type(line) == "ssh-ed25519"
    assert host_key_fingerprint(None) is None
    assert host_key_fingerprint("garbage") is None
    assert host_key_fingerprint("ssh-ed25519 not-base64!!") is None


def test_trusted_known_hosts_pins_exactly_the_stored_key():
    assert trusted_known_hosts(None) is None  # first connect: record what is offered
    assert trusted_known_hosts("") is None
    line = _key_line()
    trusted, cas, revoked = trusted_known_hosts(line)
    assert [openssh_host_key_line(key) for key in trusted] == [line]
    assert cas == [] and revoked == []
    with pytest.raises(ValueError):
        trusted_known_hosts("ssh-ed25519 AAAA")


def test_changed_message_names_the_stored_fingerprint_and_the_way_out():
    line = _key_line()
    message = host_key_changed_message("10.0.0.5:22", line, "forget it in settings")
    assert "10.0.0.5:22" in message
    assert host_key_fingerprint(line) in message
    assert "forget it in settings" in message
