"""The FrameOS release signing key, as the shell needs it.

Every release asset (Linux runtime archives, ESP32 images) is signed with one
minisign key. The devices carry the raw Ed25519 public key
(frameos/src/frameos/ota_pubkey.nim, embedded/esp32/main/fos_ota.c) and verify
the BLAKE2b-512 prehash the way minisign does. The backend never verifies an
archive itself — it runs no release bytes — but the `curl | sudo sh`
bootstrap script it hands out does, on the frame, with nothing but openssl:
the same digest, the same signature bytes, this key in the SubjectPublicKeyInfo
wrapping `openssl pkeyutl` reads.

`backend/app/utils/tests/test_release_signing.py` pins this constant to the
Nim one, so a key rotation cannot leave the two halves disagreeing.
"""
from __future__ import annotations

import base64
import hashlib
from pathlib import Path

# Raw 32-byte Ed25519 public key, base64 — byte-for-byte
# OtaSigningPublicKeyBase64 in frameos/src/frameos/ota_pubkey.nim.
RELEASE_SIGNING_PUBLIC_KEY_BASE64 = "0LvFbK8ePu0fSujVkabbyzo0gEppxSV3qhyBHQfaoMw="

# RFC 8410 SubjectPublicKeyInfo prefix for an Ed25519 key: SEQUENCE {
# SEQUENCE { OID 1.3.101.112 }, BIT STRING (32 bytes) }.
_ED25519_SPKI_PREFIX = bytes.fromhex("302a300506032b6570032100")


def release_signing_public_key_spki_base64() -> str:
    """The key as one base64 line that, wrapped in PUBLIC KEY armour, is a PEM
    file `openssl pkeyutl -pubin` accepts."""
    raw = base64.b64decode(RELEASE_SIGNING_PUBLIC_KEY_BASE64)
    if len(raw) != 32:
        raise ValueError("release signing key is not a 32-byte Ed25519 key")
    return base64.b64encode(_ED25519_SPKI_PREFIX + raw).decode("ascii")


def parse_minisig_signature(minisig: str) -> bytes:
    """The 64 signature bytes from a .minisig file.

    The first non-comment line is base64(ED || keyid8 || sig64): "ED" marks
    minisign's prehashed mode (the signature is over BLAKE2b-512 of the file).
    The trusted-comment line and its global signature are ignored on purpose
    — the backend trusts a KEY, not a comment — mirroring parseMinisigSignature
    in frameos/src/frameos/upgrade.nim and parse_minisig in fos_ota.c.
    """
    for raw_line in minisig.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("untrusted comment:") or line.startswith("trusted comment:"):
            continue
        try:
            blob = base64.b64decode(line, validate=True)
        except (ValueError, TypeError) as exc:
            raise ValueError("Release signature is not valid base64") from exc
        if len(blob) != 74:
            raise ValueError(f"Release signature blob has the wrong length ({len(blob)}, expected 74)")
        if blob[:2] != b"ED":
            raise ValueError("Release signature is not the prehashed Ed25519 form FrameOS uses")
        return blob[10:74]
    raise ValueError("Release signature file contained no signature line")


def verify_release_archive_signature(
    archive_path: str | Path,
    minisig: str,
    public_key_base64: str | None = None,
) -> None:
    """Raise ValueError unless `archive_path` was signed by the release key.

    Same check the device runtimes make before installing an OTA: BLAKE2b-512
    over the whole file, Ed25519 over that digest. The backend runs no release
    bytes itself, but it hands the archive to frames — and the download cache
    it keeps under the system temp dir is writable by every local user, so a
    cached archive is verified again on every use, not only when downloaded.
    """
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric import ed25519

    signature = parse_minisig_signature(minisig)
    raw_key = base64.b64decode(public_key_base64 or RELEASE_SIGNING_PUBLIC_KEY_BASE64)
    digest = hashlib.blake2b(digest_size=64)
    with open(archive_path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    try:
        ed25519.Ed25519PublicKey.from_public_bytes(raw_key).verify(signature, digest.digest())
    except InvalidSignature as exc:
        raise ValueError(
            f"Release signature does not verify against the FrameOS signing key: {archive_path}"
        ) from exc
