"""End-to-end encryption for cloud config backups.

Age-style asymmetric sealing: every writer holds the account's backup
*public* key and can encrypt, but only the holder of the *private* key — the
user (via the recovery code in their password manager) and the linked backend
(which already stores every secret in plaintext, so keeping the private key
adds no new exposure) — can decrypt. The cloud provider stores ciphertext it
cannot read.

Scheme per payload: ephemeral X25519 keypair → ECDH with the recipient public
key → HKDF-SHA256 (salt = ephemeral pub ‖ recipient pub) → ChaCha20-Poly1305
with a zero nonce (the derived key is unique per message). Envelope is
``b"FRBE1" + ephemeral_pub(32) + ciphertext``.
"""
from __future__ import annotations

import base64
import hashlib

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

ENVELOPE_MAGIC = b"FRBE1"
RECOVERY_CODE_PREFIX = "FRBK1"
_HKDF_INFO = b"frameos-backup-seal-v1"
_NONCE = b"\x00" * 12  # safe: the HKDF output key is unique per message


def generate_backup_private_key() -> bytes:
    return X25519PrivateKey.generate().private_bytes(
        serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption()
    )


def backup_public_key(private_key: bytes) -> bytes:
    return (
        X25519PrivateKey.from_private_bytes(private_key)
        .public_key()
        .public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    )


def backup_key_fingerprint(private_key: bytes) -> str:
    """Short id of the key, shown in the UI and stamped into every envelope,
    e.g. ``AB12-CD34``. Derived from the public key."""
    digest = hashlib.sha256(backup_public_key(private_key)).hexdigest()[:8].upper()
    return f"{digest[:4]}-{digest[4:]}"


def encode_recovery_code(private_key: bytes) -> str:
    """The recovery code users keep in their password wallet:
    ``FRBK1-XXXX-XXXX-...`` (base32 of the 32-byte private key)."""
    encoded = base64.b32encode(private_key).decode().rstrip("=")
    groups = [encoded[i : i + 4] for i in range(0, len(encoded), 4)]
    return "-".join([RECOVERY_CODE_PREFIX, *groups])


def decode_recovery_code(code: str) -> bytes:
    """Inverse of encode_recovery_code; tolerant of case, spaces, and dashes.
    Raises ValueError on anything that is not a valid recovery code."""
    normalized = code.strip().upper().replace(" ", "-")
    parts = [part for part in normalized.split("-") if part]
    if not parts or parts[0] != RECOVERY_CODE_PREFIX:
        raise ValueError("Not a FrameOS backup recovery code (expected FRBK1-…)")
    encoded = "".join(parts[1:])
    padding = "=" * (-len(encoded) % 8)
    try:
        private_key = base64.b32decode(encoded + padding)
    except Exception as exc:
        raise ValueError("The recovery code contains invalid characters") from exc
    if len(private_key) != 32:
        raise ValueError("The recovery code has the wrong length")
    return private_key


def _derive_key(shared_secret: bytes, ephemeral_pub: bytes, recipient_pub: bytes) -> bytes:
    return HKDF(
        algorithm=hashes.SHA256(), length=32, salt=ephemeral_pub + recipient_pub, info=_HKDF_INFO
    ).derive(shared_secret)


def seal(public_key: bytes, plaintext: bytes) -> bytes:
    recipient = X25519PublicKey.from_public_bytes(public_key)
    ephemeral = X25519PrivateKey.generate()
    ephemeral_pub = ephemeral.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    key = _derive_key(ephemeral.exchange(recipient), ephemeral_pub, public_key)
    ciphertext = ChaCha20Poly1305(key).encrypt(_NONCE, plaintext, None)
    return ENVELOPE_MAGIC + ephemeral_pub + ciphertext


def unseal(private_key: bytes, envelope: bytes) -> bytes:
    """Raises ValueError when the envelope is malformed or the key is wrong."""
    if len(envelope) < len(ENVELOPE_MAGIC) + 32 + 16 or not envelope.startswith(ENVELOPE_MAGIC):
        raise ValueError("Not a FrameOS backup envelope")
    ephemeral_pub = envelope[len(ENVELOPE_MAGIC) : len(ENVELOPE_MAGIC) + 32]
    ciphertext = envelope[len(ENVELOPE_MAGIC) + 32 :]
    secret = X25519PrivateKey.from_private_bytes(private_key)
    recipient_pub = backup_public_key(private_key)
    key = _derive_key(secret.exchange(X25519PublicKey.from_public_bytes(ephemeral_pub)), ephemeral_pub, recipient_pub)
    try:
        return ChaCha20Poly1305(key).decrypt(_NONCE, ciphertext, None)
    except Exception as exc:
        raise ValueError("Could not decrypt the backup with this key") from exc
