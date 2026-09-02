"""Signing for backend-built ESP32 OTA images.

The cloud OTA path is signed with the release key baked into every published
image (tools/sign_firmware.py, fos_ota_pubkey.h). Images the backend builds
itself cannot carry that signature, so the backend-path OTA used to be
"whatever the backend URL serves" — over plain HTTP on the LAN, a persistent
firmware RCE for anyone who can answer as the backend.

Every install now has its own Ed25519 signing key, derived from SECRET_KEY
(no new secret to store or back up). The build bakes the public key into the
frame's generated_config.h, the finished OTA image is signed in minisign's
pre-hashed format (Ed25519 over BLAKE2b-512, the same shape the cloud path
verifies), and the device refuses any image whose signature does not verify
against the baked key. Rotating SECRET_KEY keeps PREVIOUS_SECRET_KEYS' keys
signing too, so a device built under the old key still updates.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
from dataclasses import dataclass
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

from app import config as app_config

DERIVATION_INFO = b"frameos embedded ota signing v1"
SIG_ALG_PREHASHED = b"ED"  # minisign: Ed25519 over BLAKE2b-512(file)


@dataclass(frozen=True)
class OtaSigningKey:
    seed: bytes
    public: bytes
    key_id: bytes

    @property
    def key_id_hex(self) -> str:
        return self.key_id.hex()

    @property
    def public_hex(self) -> str:
        return self.public.hex()


def derive_signing_key(secret: str) -> OtaSigningKey:
    seed = hmac.new(secret.encode("utf-8"), DERIVATION_INFO, hashlib.sha256).digest()
    private = Ed25519PrivateKey.from_private_bytes(seed)
    public = private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return OtaSigningKey(seed=seed, public=public, key_id=hashlib.sha256(public).digest()[:8])


def signing_keys() -> list[OtaSigningKey]:
    """The current key first, then one per previous SECRET_KEY still honoured."""
    cfg = app_config.config
    secrets = [cfg.SECRET_KEY, *(getattr(cfg, "PREVIOUS_SECRET_KEYS", None) or [])]
    keys: list[OtaSigningKey] = []
    for secret in secrets:
        if not secret:
            continue
        key = derive_signing_key(secret)
        if all(key.key_id != existing.key_id for existing in keys):
            keys.append(key)
    return keys


def current_signing_key() -> OtaSigningKey | None:
    keys = signing_keys()
    return keys[0] if keys else None


def blake2b_digest(path: Path | str) -> bytes:
    digest = hashlib.blake2b(digest_size=64)
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.digest()


def sign_digest(key: OtaSigningKey, digest: bytes) -> str:
    """The base64 minisig blob: ED + key id + Ed25519 signature over the digest."""
    signature = Ed25519PrivateKey.from_private_bytes(key.seed).sign(digest)
    return base64.b64encode(SIG_ALG_PREHASHED + key.key_id + signature).decode("ascii")


def sign_image(path: Path | str) -> dict[str, str]:
    """``{key_id_hex: minisig}`` for every key this install honours — the
    manifest serves them all and the device picks the one whose key id it
    was built with."""
    digest = blake2b_digest(path)
    return {key.key_id_hex: sign_digest(key, digest) for key in signing_keys()}


def verify_minisig(public: bytes, key_id: bytes, minisig: str, digest: bytes) -> bool:
    try:
        blob = base64.b64decode(minisig)
    except ValueError:
        return False
    if len(blob) != 74 or blob[:2] != SIG_ALG_PREHASHED or blob[2:10] != key_id:
        return False
    try:
        Ed25519PublicKey.from_public_bytes(public).verify(blob[10:74], digest)
    except Exception:  # noqa: BLE001 — cryptography raises InvalidSignature
        return False
    return True
