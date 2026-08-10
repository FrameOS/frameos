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

Usage:
  sign_firmware.py keygen --secret-out KEYFILE --public-out PUBFILE \
      [--key-id HEX16]
  sign_firmware.py sign --secret KEYFILE_OR_ENV file.bin [file2.bin ...]
      (writes file.bin.minisig next to each input; secret may be a path or
       the literal name of an environment variable holding the base64 seed)
  sign_firmware.py verify --public PUBFILE file.bin
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
    seed, key_id = read_secret(args.secret)
    private = Ed25519PrivateKey.from_private_bytes(seed)
    for path in args.files:
        digest = blake2b_digest(path)
        signature = private.sign(digest)
        blob = SIG_ALG_PREHASHED + key_id + signature
        out = path + ".minisig"
        with open(out, "w", encoding="utf-8") as f:
            f.write(f"untrusted comment: signature from FrameOS firmware key\n")
            f.write(base64.b64encode(blob).decode() + "\n")
            # trusted comment + global signature (minisign appends these; the
            # device ignores them, minisign -V validates them)
            trusted = f"trusted comment: frameos {os.path.basename(path)}\n"
            global_sig = private.sign(signature + trusted.split(": ", 1)[1].strip().encode())
            f.write(trusted)
            f.write(base64.b64encode(global_sig).decode() + "\n")
        print(f"signed {path} -> {out}")


def verify_blob(public_pem: bytes, key_id: bytes, sig_blob: bytes, digest: bytes) -> None:
    if len(sig_blob) != 74 or sig_blob[:2] != SIG_ALG_PREHASHED:
        raise SystemExit("bad signature blob")
    if sig_blob[2:10] != key_id:
        raise SystemExit("signature key id does not match the public key")
    Ed25519PublicKey.from_public_bytes(public_pem).verify(sig_blob[10:74], digest)


def cmd_verify(args: argparse.Namespace) -> None:
    public, key_id = read_public(args.public)
    sig_lines = [line.strip() for line in open(args.file + ".minisig", encoding="utf-8")
                 if line.strip() and not line.startswith(("untrusted comment:", "trusted comment:"))]
    verify_blob(public, key_id, base64.b64decode(sig_lines[0]), blake2b_digest(args.file))
    print(f"{args.file}: signature OK")


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
    sign.add_argument("files", nargs="+")
    sign.set_defaults(func=cmd_sign)

    verify = sub.add_parser("verify")
    verify.add_argument("--public", required=True)
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
