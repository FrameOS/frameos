"""verify_release_signature, the shell function the bootstrap script runs on
the frame, against a signature minted here: the real BLAKE2b-512 prehash, the
real minisign blob layout, openssl doing the Ed25519 verify.

Needs an OpenSSL 3 `openssl` (LibreSSL, macOS's default, has no `pkeyutl
-rawin`); Homebrew's openssl@3 is tried when the PATH one is too old.
"""
from __future__ import annotations

import base64
import hashlib
import os
import shutil
import subprocess
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519

from app.api.frame_bootstrap import VERIFY_RELEASE_SIGNATURE_SH


def _openssl() -> str | None:
    for candidate in [shutil.which("openssl"), "/opt/homebrew/opt/openssl@3/bin/openssl", "/usr/local/opt/openssl@3/bin/openssl"]:
        if candidate and Path(candidate).is_file():
            version = subprocess.run([candidate, "version"], capture_output=True, text=True).stdout
            if version.startswith("OpenSSL 3") or version.startswith("OpenSSL 1.1"):
                return candidate
    return None


OPENSSL = _openssl()


def _minisig(private_key: ed25519.Ed25519PrivateKey, archive: bytes, key_id: bytes = b"\x01" * 8) -> str:
    digest = hashlib.blake2b(archive, digest_size=64).digest()
    blob = b"ED" + key_id + private_key.sign(digest)
    return "untrusted comment: signature from test key\n" + base64.b64encode(blob).decode() + "\ntrusted comment: test\n" + base64.b64encode(b"x" * 64).decode() + "\n"


def _spki(public_key: ed25519.Ed25519PublicKey) -> str:
    der = public_key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    return base64.b64encode(der).decode()


def _run(tmp_path: Path, archive: bytes, minisig: str, spki: str) -> subprocess.CompletedProcess[str]:
    (tmp_path / "frameos.tar.gz").write_bytes(archive)
    (tmp_path / "frameos.tar.gz.minisig").write_text(minisig)
    script = (
        "set -e\n"
        f"work_dir={tmp_path}\n"
        f"FRAMEOS_RELEASE_SIGNING_KEY_SPKI={spki}\n"
        + VERIFY_RELEASE_SIGNATURE_SH
        + f'\nverify_release_signature "{tmp_path}/frameos.tar.gz" "{tmp_path}/frameos.tar.gz.minisig"\n'
    )
    env = dict(os.environ)
    env["PATH"] = str(Path(OPENSSL).parent) + os.pathsep + env.get("PATH", "")
    return subprocess.run(["sh", "-c", script], capture_output=True, text=True, env=env, timeout=60)


@pytest.mark.skipif(OPENSSL is None, reason="no OpenSSL 3 binary available")
def test_valid_signature_passes(tmp_path: Path):
    key = ed25519.Ed25519PrivateKey.generate()
    archive = os.urandom(70_000)
    result = _run(tmp_path, archive, _minisig(key, archive), _spki(key.public_key()))
    assert result.returncode == 0, result.stderr
    assert "Release signature verified" in result.stdout


@pytest.mark.skipif(OPENSSL is None, reason="no OpenSSL 3 binary available")
def test_tampered_archive_is_refused(tmp_path: Path):
    key = ed25519.Ed25519PrivateKey.generate()
    archive = os.urandom(70_000)
    minisig = _minisig(key, archive)
    tampered = bytearray(archive)
    tampered[1234] ^= 0x01
    result = _run(tmp_path, bytes(tampered), minisig, _spki(key.public_key()))
    assert result.returncode != 0
    assert "does not verify" in result.stderr


@pytest.mark.skipif(OPENSSL is None, reason="no OpenSSL 3 binary available")
def test_wrong_key_is_refused(tmp_path: Path):
    key = ed25519.Ed25519PrivateKey.generate()
    other = ed25519.Ed25519PrivateKey.generate()
    archive = os.urandom(4096)
    result = _run(tmp_path, archive, _minisig(key, archive), _spki(other.public_key()))
    assert result.returncode != 0
    assert "does not verify" in result.stderr


@pytest.mark.skipif(OPENSSL is None, reason="no OpenSSL 3 binary available")
def test_non_prehashed_or_malformed_signature_is_refused(tmp_path: Path):
    key = ed25519.Ed25519PrivateKey.generate()
    archive = os.urandom(4096)
    spki = _spki(key.public_key())
    pure = _minisig(key, archive).replace(base64.b64encode(b"ED").decode()[:2], "Ed", 1)
    # Replace the blob with a pure (non-prehashed) "Ed" tag.
    digest = hashlib.blake2b(archive, digest_size=64).digest()
    blob = b"Ed" + b"\x01" * 8 + key.sign(digest)
    pure = "untrusted comment: x\n" + base64.b64encode(blob).decode() + "\n"
    result = _run(tmp_path, archive, pure, spki)
    assert result.returncode != 0
    assert "prehashed" in result.stderr

    result = _run(tmp_path, archive, "untrusted comment: only a comment\n", spki)
    assert result.returncode != 0
    assert "empty or malformed" in result.stderr

    result = _run(tmp_path, archive, "untrusted comment: x\nAAAA\n", spki)
    assert result.returncode != 0
    assert "wrong length" in result.stderr
