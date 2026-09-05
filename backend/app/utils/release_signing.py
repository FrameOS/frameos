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
