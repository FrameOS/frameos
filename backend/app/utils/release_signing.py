"""The FrameOS release signing key, as the backend and the shell need it.

Every release asset (Linux runtime archives, Buildroot SD images, ESP32
images) is signed with one minisign key. The devices carry the raw Ed25519
public key (frameos/src/frameos/ota_pubkey.nim, embedded/esp32/main/fos_ota.c)
and verify the BLAKE2b-512 prehash the way minisign does, plus the signed
trusted comment naming the asset (version + target). The backend makes the
same check on everything it downloads or reuses from its cache
(`verify_release_archive_signature`), and the `curl | sudo sh` bootstrap
script it hands out makes it again on the frame, with nothing but openssl:
the same digest, the same signature bytes, this key in the SubjectPublicKeyInfo
wrapping `openssl pkeyutl` reads.

`backend/app/utils/tests/test_release_signing.py` pins this constant to the
Nim one, so a key rotation cannot leave the two halves disagreeing.
"""
from __future__ import annotations

import base64
import hashlib
from dataclasses import dataclass
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


# tools/sign_firmware.py writes `trusted comment: frameos <asset name>`.
TRUSTED_COMMENT_PREFIX = "frameos "


@dataclass(frozen=True)
class ReleaseSignature:
    """A .minisig, taken apart: the file signature, the trusted comment (byte
    for byte — it is signed) and the global signature over both."""

    signature: bytes
    trusted_comment: str
    global_signature: bytes


def _decode_signature_line(line: str) -> bytes:
    try:
        return base64.b64decode(line, validate=True)
    except (ValueError, TypeError) as exc:
        raise ValueError("Release signature is not valid base64") from exc


def parse_minisig(minisig: str) -> ReleaseSignature:
    """A .minisig is four lines: an untrusted comment, base64(ED || keyid8 ||
    sig64) — "ED" marks minisign's prehashed mode, the signature is over
    BLAKE2b-512 of the file — then `trusted comment: …` and the global
    signature, Ed25519 over sig64 || trusted comment.

    The first signature says "FrameOS released these bytes"; the comment says
    AS WHAT, and the global signature makes that the signer's word. All of it
    is required: a file with no comment half is refused rather than treated as
    an older format (every signed release carries one). Mirrors parseMinisig
    in frameos/src/frameos/upgrade.nim and fos_minisig.c.
    """
    blobs: list[str] = []
    comments: list[str] = []
    for raw_line in minisig.splitlines():
        if not raw_line.strip() or raw_line.startswith("untrusted comment:"):
            continue
        if raw_line.startswith("trusted comment: "):
            comments.append(raw_line[len("trusted comment: "):])
            continue
        blobs.append(raw_line.strip())
    if not blobs:
        raise ValueError("Release signature file contained no signature line")
    blob = _decode_signature_line(blobs[0])
    if len(blob) != 74:
        raise ValueError(f"Release signature blob has the wrong length ({len(blob)}, expected 74)")
    if blob[:2] != b"ED":
        raise ValueError("Release signature is not the prehashed Ed25519 form FrameOS uses")
    if len(comments) != 1 or len(blobs) != 2:
        raise ValueError(
            "Release signature does not say which release it is for (no trusted comment and global signature)"
        )
    global_signature = _decode_signature_line(blobs[1])
    if len(global_signature) != 64:
        raise ValueError(
            f"Release global signature has the wrong length ({len(global_signature)}, expected 64)"
        )
    return ReleaseSignature(blob[10:74], comments[0], global_signature)


def parse_minisig_signature(minisig: str) -> bytes:
    """The 64 file-signature bytes from a .minisig file."""
    return parse_minisig(minisig).signature


def release_asset_name(url_or_name: str) -> str:
    """The asset a release URL names: its last path segment."""
    return url_or_name.split("?", 1)[0].rstrip("/").rsplit("/", 1)[-1]


def verify_release_archive_signature(
    archive_path: str | Path,
    minisig: str,
    asset_name: str,
    public_key_base64: str | None = None,
) -> None:
    """Raise ValueError unless `archive_path` was signed by the release key
    AS `asset_name` (`frameos-<version>-<target>.tar.gz`, `…-buildroot.img.gz`).

    Same check the device runtimes make before installing an OTA: BLAKE2b-512
    over the whole file, Ed25519 over that digest — and the trusted comment,
    covered by the global signature, must name the asset that was asked for.
    Without the second half a signature only proves the bytes were released
    once: anyone with release-upload rights (no signing key) could attach an
    older or other-architecture archive under this version's name, and it
    would be deployed to frames with a valid signature. The name comes from
    the URL the backend built from its own version and the frame's target,
    never from the download. The backend runs no release
    bytes itself, but it hands the archive to frames — and the download cache
    it keeps under the system temp dir is writable by every local user, so a
    cached archive is verified again on every use, not only when downloaded.
    """
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric import ed25519

    parsed = parse_minisig(minisig)
    raw_key = base64.b64decode(public_key_base64 or RELEASE_SIGNING_PUBLIC_KEY_BASE64)
    public_key = ed25519.Ed25519PublicKey.from_public_bytes(raw_key)
    try:
        public_key.verify(parsed.global_signature, parsed.signature + parsed.trusted_comment.encode("utf-8"))
    except InvalidSignature as exc:
        raise ValueError("Release signature's trusted comment is not signed by the FrameOS signing key") from exc
    if not asset_name or parsed.trusted_comment != TRUSTED_COMMENT_PREFIX + asset_name:
        raise ValueError(
            f'Release signature is for "{parsed.trusted_comment}", not for {asset_name} — '
            "refusing a signed archive offered as a different version or target"
        )
    digest = hashlib.blake2b(digest_size=64)
    with open(archive_path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    try:
        public_key.verify(parsed.signature, digest.digest())
    except InvalidSignature as exc:
        raise ValueError(
            f"Release signature does not verify against the FrameOS signing key: {archive_path}"
        ) from exc
