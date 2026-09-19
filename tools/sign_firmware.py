#!/usr/bin/env python3
"""Sign FrameOS firmware images (minisign-compatible, Ed25519 over BLAKE2b-512).

The cloud OTA path refuses any image whose signature does not verify against
the public key baked into the running firmware (docs/cloud-frames.md,
"Signed OTA"). Signatures use minisign's pre-hashed format ("ED"): the
Ed25519 message is the BLAKE2b-512 digest of the file, so devices can hash
incrementally while streaming the download to flash and verify before
switching boot slots.

Key handling: the SECRET is a raw 32-byte Ed25519 seed, base64-encoded —
deliberately not minisign's scrypt-encrypted container, so CI can hold it as
a plain secret (FRAMEOS_FIRMWARE_SIGNING_KEY). The PUBLIC side and the
.minisig files are bit-compatible with minisign, so `minisign -V` works.

What a signature says: the file signature covers the BYTES; the trusted
comment — `frameos <asset name>`, e.g. `frameos frameos-2026.9.19-debian-
bookworm-arm64.tar.gz` — names the VERSION and TARGET those bytes were
released as, and minisign's global signature (Ed25519 over signature ||
trusted comment) binds the two together. Every verifier checks all three:
the bytes, the global signature, and that the comment names the asset it
asked for. Without that last step a valid signature only proves "FrameOS
released these bytes once", and an old or other-architecture archive could be
re-served under a new tag by anyone who can upload release assets (or answer
for GitHub) without ever touching the key. A file must therefore be signed
under its release name — or with --name when it lives under another one.

Usage:
  sign_firmware.py keygen --secret-out KEYFILE --public-out PUBFILE \
      [--key-id HEX16]
  sign_firmware.py sign --secret KEYFILE_OR_ENV [--name ASSET] file.bin [...]
      (writes file.bin.minisig next to each input; secret may be a path or
       the literal name of an environment variable holding the base64 seed;
       --name signs ONE file as the named release asset instead of as its
       own basename)
  sign_firmware.py verify --public PUBFILE [--name ASSET] file.bin
      (bytes, global signature and the asset name in the trusted comment)
  sign_firmware.py c-header --public PUBFILE
      (prints the pubkey + key id as C initializers for the firmware)
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import os
import secrets
import struct
import sys

from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives import serialization

SIG_ALG_PREHASHED = b"ED"  # minisign: Ed25519 over BLAKE2b-512(file)

# The trusted comment of every FrameOS release signature is this prefix plus
# the asset's release file name. Verifiers compare the whole line, so the
# format is part of the contract with every frame already in the field:
# frameos/src/frameos/upgrade.nim, embedded/esp32/main/fos_minisig.c,
# backend/app/utils/release_signing.py, scripts/frameos-setup.sh and the two
# cloud release-signing.ts files all build the same string.
TRUSTED_COMMENT_PREFIX = "frameos "


def trusted_comment_for(asset_name: str) -> str:
    if not asset_name or any(c in asset_name for c in "\r\n/") or asset_name != asset_name.strip():
        raise SystemExit(f"not a usable release asset name: {asset_name!r}")
    return TRUSTED_COMMENT_PREFIX + asset_name


def blake2b_digest(path: str) -> bytes:
    h = hashlib.blake2b(digest_size=64)
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.digest()


def read_secret(source: str) -> tuple[bytes, bytes]:
    """Returns (seed32, key_id8). Accepts a file path or an env var name."""
    if os.path.exists(source):
        raw = open(source, "r", encoding="utf-8").read()
    elif source in os.environ:
        raw = os.environ[source]
    else:
        raise SystemExit(f"secret not found (no file or env var named {source!r})")
    lines = [line.strip() for line in raw.strip().splitlines()
             if line.strip() and not line.startswith("untrusted comment:")]
    blob = base64.b64decode(lines[-1])
    if len(blob) != 42 or blob[:2] != SIG_ALG_PREHASHED:
        raise SystemExit("secret key blob must be base64(ED + keyid8 + seed32)")
    return blob[10:42], blob[2:10]


def read_public(path: str) -> tuple[bytes, bytes]:
    """Returns (pubkey32, key_id8) from a minisign-format public key file."""
    lines = [line.strip() for line in open(path, encoding="utf-8")
             if line.strip() and not line.startswith("untrusted comment:")]
    blob = base64.b64decode(lines[-1])
    if len(blob) != 42 or blob[:2] != b"Ed":
        raise SystemExit("public key blob must be base64(Ed + keyid8 + pubkey32)")
    return blob[10:42], blob[2:10]


def cmd_keygen(args: argparse.Namespace) -> None:
    key_id = bytes.fromhex(args.key_id) if args.key_id else secrets.token_bytes(8)
    if len(key_id) != 8:
        raise SystemExit("--key-id must be 16 hex chars (8 bytes)")
    private = Ed25519PrivateKey.generate()
    seed = private.private_bytes(
        serialization.Encoding.Raw,
        serialization.PrivateFormat.Raw,
        serialization.NoEncryption(),
    )
    public = private.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw)

    with open(args.secret_out, "w", encoding="utf-8") as f:
        f.write("untrusted comment: FrameOS firmware signing SECRET key"
                " — store offline / in CI secrets, never commit\n")
        f.write(base64.b64encode(SIG_ALG_PREHASHED + key_id + seed).decode() + "\n")
    os.chmod(args.secret_out, 0o600)
    with open(args.public_out, "w", encoding="utf-8") as f:
        f.write("untrusted comment: FrameOS firmware signing public key\n")
        f.write(base64.b64encode(b"Ed" + key_id + public).decode() + "\n")
    print(f"key id {key_id.hex()}: secret -> {args.secret_out}, "
          f"public -> {args.public_out}")


def cmd_sign(args: argparse.Namespace) -> None:
    if args.name and len(args.files) != 1:
        raise SystemExit("--name names one asset, so it takes exactly one file")
    seed, key_id = read_secret(args.secret)
    private = Ed25519PrivateKey.from_private_bytes(seed)
    for path in args.files:
        comment = trusted_comment_for(args.name or os.path.basename(path))
        digest = blake2b_digest(path)
        signature = private.sign(digest)
        blob = SIG_ALG_PREHASHED + key_id + signature
        out = path + ".minisig"
        with open(out, "w", encoding="utf-8") as f:
            f.write(f"untrusted comment: signature from FrameOS firmware key\n")
            f.write(base64.b64encode(blob).decode() + "\n")
            # trusted comment + global signature: what binds these bytes to
            # the version and target in the asset name (module docstring).
            global_sig = private.sign(signature + comment.encode())
            f.write(f"trusted comment: {comment}\n")
            f.write(base64.b64encode(global_sig).decode() + "\n")
        print(f"signed {path} -> {out} ({comment})")


def verify_blob(public_pem: bytes, key_id: bytes, sig_blob: bytes, digest: bytes) -> None:
    if len(sig_blob) != 74 or sig_blob[:2] != SIG_ALG_PREHASHED:
        raise SystemExit("bad signature blob")
    if sig_blob[2:10] != key_id:
        raise SystemExit("signature key id does not match the public key")
    Ed25519PublicKey.from_public_bytes(public_pem).verify(sig_blob[10:74], digest)


def cmd_verify(args: argparse.Namespace) -> None:
    public, key_id = read_public(args.public)
    lines = [line.rstrip("\r\n") for line in open(args.file + ".minisig", encoding="utf-8")]
    sig_lines = [line.strip() for line in lines
                 if line.strip() and not line.startswith(("untrusted comment:", "trusted comment:"))]
    comments = [line[len("trusted comment: "):] for line in lines
                if line.startswith("trusted comment: ")]
    if len(sig_lines) != 2 or len(comments) != 1:
        raise SystemExit(f"{args.file}.minisig: expected a signature, one trusted comment "
                         "and a global signature")
    sig_blob = base64.b64decode(sig_lines[0])
    verify_blob(public, key_id, sig_blob, blake2b_digest(args.file))
    # The global signature is what makes the comment trustworthy; the name
    # check is what makes it mean something (module docstring).
    Ed25519PublicKey.from_public_bytes(public).verify(
        base64.b64decode(sig_lines[1]), sig_blob[10:74] + comments[0].encode())
    expected = trusted_comment_for(args.name or os.path.basename(args.file))
    if comments[0] != expected:
        raise SystemExit(f"{args.file}: signed as {comments[0]!r}, expected {expected!r}")
    print(f"{args.file}: signature OK ({comments[0]})")


def cmd_c_header(args: argparse.Namespace) -> None:
    public, key_id = read_public(args.public)
    pub_bytes = ", ".join(f"0x{b:02x}" for b in public)
    id_bytes = ", ".join(f"0x{b:02x}" for b in key_id)
    print("/* Generated by tools/sign_firmware.py c-header — the firmware")
    print(" * refuses cloud OTA images not signed by this key. */")
    print(f"static const uint8_t FOS_OTA_SIGNING_PUBKEY[32] = {{{pub_bytes}}};")
    print(f"static const uint8_t FOS_OTA_SIGNING_KEY_ID[8] = {{{id_bytes}}};")


def cmd_nim_const(args: argparse.Namespace) -> None:
    """The same trust anchor as c-header, for the Nim runtime.

    Buildroot and Pi frames verify release tarballs with this key
    (frameos/src/frameos/upgrade.nim). Base64 rather than a byte array
    because the Nim verifier takes the key in the same base64 form the
    device-identity code already uses.
    """
    public, key_id = read_public(args.public)
    print("## Generated by tools/sign_firmware.py nim-const — the runtime refuses")
    print("## release archives not signed by this key. Regenerate after a key")
    print("## rotation, together with embedded/esp32/main/fos_ota_pubkey.h: a")
    print("## device that trusts a retired key is the whole point of having one.")
    print("")
    print("const")
    print(f'  OtaSigningPublicKeyBase64* = "{base64.b64encode(public).decode()}"')
    print(f'  OtaSigningKeyIdHex* = "{key_id.hex()}"')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    keygen = sub.add_parser("keygen")
    keygen.add_argument("--secret-out", required=True)
    keygen.add_argument("--public-out", required=True)
    keygen.add_argument("--key-id")
    keygen.set_defaults(func=cmd_keygen)

    sign = sub.add_parser("sign")
    sign.add_argument("--secret", required=True)
    sign.add_argument("--name", help="release asset name to sign ONE file as (default: its basename)")
    sign.add_argument("files", nargs="+")
    sign.set_defaults(func=cmd_sign)

    verify = sub.add_parser("verify")
    verify.add_argument("--public", required=True)
    verify.add_argument("--name", help="release asset name the file must be signed as (default: its basename)")
    verify.add_argument("file")
    verify.set_defaults(func=cmd_verify)

    c_header = sub.add_parser("c-header")
    c_header.add_argument("--public", required=True)
    c_header.set_defaults(func=cmd_c_header)

    nim_const = sub.add_parser("nim-const")
    nim_const.add_argument("--public", required=True)
    nim_const.set_defaults(func=cmd_nim_const)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
