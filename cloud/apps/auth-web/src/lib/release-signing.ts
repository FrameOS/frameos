// The FrameOS release signing key, as the cloud needs it.
//
// Every release asset — Linux runtime archives, ESP32 images, and the
// Buildroot SD-card images — is signed with one minisign key on a
// GitHub-hosted runner (.github/workflows/docker-publish-multi.yml, "Sign
// release archives and firmware"). The devices verify the archives and OTA
// images against the raw Ed25519 key they carry
// (frameos/src/frameos/ota_pubkey.nim, embedded/esp32/main/fos_ota.c) and the
// self-hosted backend verifies the SD image it patches
// (backend/app/utils/release_signing.py). This is the cloud's copy for the
// one release asset the cloud hands out that no device ever checks: the SD
// image the browser flasher writes (app/api/frames/sd-image).
//
// `release-signing.test.ts` pins the constant to the Nim one, so a key
// rotation cannot leave the two halves disagreeing.

import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";

// Raw 32-byte Ed25519 public key, base64 — byte-for-byte
// OtaSigningPublicKeyBase64 in frameos/src/frameos/ota_pubkey.nim.
export const releaseSigningPublicKeyBase64 =
  "0LvFbK8ePu0fSujVkabbyzo0gEppxSV3qhyBHQfaoMw=";

// RFC 8410 SubjectPublicKeyInfo prefix for an Ed25519 key: SEQUENCE {
// SEQUENCE { OID 1.3.101.112 }, BIT STRING (32 bytes) }. Node's crypto reads
// keys in this wrapping; minisign stores the bare 32 bytes.
const ed25519SpkiPrefix = Buffer.from("302a300506032b6570032100", "hex");

function releasePublicKey(publicKeyBase64 = releaseSigningPublicKeyBase64) {
  const raw = Buffer.from(publicKeyBase64, "base64");
  if (raw.length !== 32) {
    throw new Error("release signing key is not a 32-byte Ed25519 key");
  }
  return createPublicKey({
    format: "der",
    key: Buffer.concat([ed25519SpkiPrefix, raw]),
    type: "spki",
  });
}

/**
 * The 64 signature bytes from a .minisig file, or undefined when the text is
 * not one.
 *
 * The first non-comment line is base64(ED || keyid8 || sig64): "ED" marks
 * minisign's prehashed mode (the signature is over BLAKE2b-512 of the file).
 * The trusted-comment line and its global signature are ignored on purpose —
 * the cloud trusts a KEY, not a comment — mirroring parse_minisig_signature
 * in backend/app/utils/release_signing.py, parseMinisigSignature in
 * frameos/src/frameos/upgrade.nim and parse_minisig in fos_ota.c.
 */
export function parseMinisigSignature(minisig: string): Buffer | undefined {
  for (const rawLine of minisig.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (
      !line ||
      line.startsWith("untrusted comment:") ||
      line.startsWith("trusted comment:")
    ) {
      continue;
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(line)) {
      return undefined;
    }
    const blob = Buffer.from(line, "base64");
    if (blob.length !== 74 || blob.subarray(0, 2).toString("latin1") !== "ED") {
      return undefined;
    }
    return blob.subarray(10, 74);
  }
  return undefined;
}

/** A BLAKE2b-512 hasher: feed it the release bytes, then pass `.digest()` to
 *  verifyReleaseDigest. Streaming, so a gigabyte image never sits in memory. */
export function createReleaseDigest() {
  return createHash("blake2b512");
}

/**
 * Whether `digest` (BLAKE2b-512 of the whole asset) was signed by the release
 * key. Same check the device runtimes make before installing an OTA. Never
 * throws on bad input — an unparseable signature is simply not valid.
 */
export function verifyReleaseDigest(
  digest: Uint8Array,
  minisig: string,
  publicKeyBase64?: string,
): boolean {
  const signature = parseMinisigSignature(minisig);
  if (!signature || digest.length !== 64) {
    return false;
  }
  try {
    return verifySignature(null, digest, releasePublicKey(publicKeyBase64), signature);
  } catch {
    return false;
  }
}

/** Convenience for small assets already in memory. */
export function verifyReleaseBytes(
  bytes: Uint8Array,
  minisig: string,
  publicKeyBase64?: string,
): boolean {
  return verifyReleaseDigest(
    createReleaseDigest().update(bytes).digest(),
    minisig,
    publicKeyBase64,
  );
}
