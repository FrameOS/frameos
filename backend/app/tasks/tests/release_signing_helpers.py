"""Test-side release signing: mint a key, sign a fake archive the way the
release pipeline does (minisign prehashed Ed25519 over BLAKE2b-512), and point
the module's trusted key at it. The precompiled-release cache verifies every
archive it downloads or reuses, so any test that fakes `_download` must hand
out a signature too."""
from __future__ import annotations

import base64
import hashlib
import shutil
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519

from app.utils import release_signing

TEST_SIGNING_KEY = ed25519.Ed25519PrivateKey.generate()
TEST_SIGNING_PUBLIC_KEY_BASE64 = base64.b64encode(
    TEST_SIGNING_KEY.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
).decode()


def minisig_for(archive: Path, key: ed25519.Ed25519PrivateKey = TEST_SIGNING_KEY) -> str:
    digest = hashlib.blake2b(archive.read_bytes(), digest_size=64).digest()
    blob = b"ED" + b"\x01" * 8 + key.sign(digest)
    return "untrusted comment: test\n" + base64.b64encode(blob).decode() + "\n"


def trust_test_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(release_signing, "RELEASE_SIGNING_PUBLIC_KEY_BASE64", TEST_SIGNING_PUBLIC_KEY_BASE64)


def signing_download(archive: Path, calls: list[str] | None = None):
    """A `_download` fake: the archive for the asset URL, its signature for the .minisig URL."""

    async def fake_download(url: str, destination: Path, _timeout: float) -> None:
        if calls is not None:
            calls.append(url)
        if url.endswith(".minisig"):
            destination.write_text(minisig_for(archive), encoding="utf-8")
        else:
            shutil.copy2(archive, destination)

    return fake_download
