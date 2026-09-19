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

/** A .minisig, taken apart. */
export interface ReleaseSignature {
  /** Ed25519 over BLAKE2b-512 of the asset. */
  signature: Buffer;
  /** The text after `trusted comment: `, byte for byte — it is signed. */
  trustedComment: string;
  /** Ed25519 over signature || trustedComment. */
  globalSignature: Buffer;
}

// tools/sign_firmware.py writes `trusted comment: frameos <asset name>`.
const trustedCommentPrefix = "frameos ";
const trustedCommentLine = "trusted comment: ";

function decodeSignatureLine(line: string): Buffer | undefined {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(line) ? Buffer.from(line, "base64") : undefined;
}

/**
 * The parts of a .minisig file, or undefined when the text is not a complete
 * one.
 *
 * Four lines: an untrusted comment, base64(ED || keyid8 || sig64) — "ED"
 * marks minisign's prehashed mode, the signature is over BLAKE2b-512 of the
 * file — then `trusted comment: …` and the global signature over sig64 ||
 * comment. The first signature says "FrameOS released these bytes"; the
 * comment says AS WHAT, and the global signature makes that the signer's
 * word. All of it is required: a file with no comment half is refused rather
 * than treated as an older format. Mirrors parse_minisig in
 * backend/app/utils/release_signing.py, parseMinisig in
 * frameos/src/frameos/upgrade.nim and fos_minisig.c.
 */
export function parseMinisig(minisig: string): ReleaseSignature | undefined {
  const blobs: string[] = [];
  const comments: string[] = [];
  for (const rawLine of minisig.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.startsWith("untrusted comment:")) {
      continue;
    }
    if (rawLine.startsWith(trustedCommentLine)) {
      comments.push(rawLine.slice(trustedCommentLine.length));
      continue;
    }
    blobs.push(rawLine.trim());
  }
  const [signatureLine, globalSignatureLine] = blobs;
  const [trustedComment] = comments;
  if (
    blobs.length !== 2 ||
    comments.length !== 1 ||
    signatureLine === undefined ||
    globalSignatureLine === undefined ||
    trustedComment === undefined
  ) {
    return undefined;
  }
  const blob = decodeSignatureLine(signatureLine);
  const globalSignature = decodeSignatureLine(globalSignatureLine);
  if (
    !blob ||
    blob.length !== 74 ||
    blob.subarray(0, 2).toString("latin1") !== "ED" ||
    !globalSignature ||
    globalSignature.length !== 64
  ) {
    return undefined;
  }
  return {
    signature: blob.subarray(10, 74),
    trustedComment,
    globalSignature,
  };
}

/** The 64 file-signature bytes from a .minisig file, or undefined. */
export function parseMinisigSignature(minisig: string): Buffer | undefined {
  return parseMinisig(minisig)?.signature;
}

/** `frameos-<version>-<target><extension>` for a release tag ("v2026.9.19"). */
export function releaseAssetName(
  releaseTag: string | undefined,
  targetAndExtension: string,
): string | undefined {
  const version = (releaseTag ?? "").replace(/^v/, "");
  if (!/^\d+(\.\d+)*$/.test(version)) {
    return undefined;
  }
  return `frameos-${version}-${targetAndExtension}`;
}

/**
 * Whether `minisig` was made for `assetName`: the trusted comment is signed by
 * the release key (the global signature) and is exactly `frameos <assetName>`.
 *
 * The file signature alone only proves the bytes were released once. Which
 * version and target they are comes from GitHub metadata, so anyone with
 * release-upload rights — no signing key — could attach an older or
 * other-board signed image under a new tag; this is what refuses it
 * (docs/security-todo.md). Needs no asset bytes, so it runs before a
 * gigabyte is hashed. Never throws.
 */
export function verifyReleaseBinding(
  minisig: string,
  assetName: string | undefined,
  publicKeyBase64?: string,
): boolean {
  const parsed = parseMinisig(minisig);
  if (!parsed || !assetName || parsed.trustedComment !== trustedCommentPrefix + assetName) {
    return false;
  }
  try {
    return verifySignature(
      null,
      Buffer.concat([parsed.signature, Buffer.from(parsed.trustedComment, "utf8")]),
      releasePublicKey(publicKeyBase64),
      parsed.globalSignature,
    );
  } catch {
    return false;
  }
}

/** A BLAKE2b-512 hasher: feed it the release bytes, then pass `.digest()` to
 *  verifyReleaseDigest. Streaming, so a gigabyte image never sits in memory. */
export function createReleaseDigest() {
  return createHash("blake2b512");
}

/**
 * Whether `digest` (BLAKE2b-512 of the whole asset) was signed by the release
 * key AS `assetName` (verifyReleaseBinding). Same check the device runtimes
 * make before installing an OTA. Never throws on bad input — an unparseable
 * signature is simply not valid.
 */
export function verifyReleaseDigest(
  digest: Uint8Array,
  minisig: string,
  assetName: string | undefined,
  publicKeyBase64?: string,
): boolean {
  const signature = parseMinisigSignature(minisig);
  if (!signature || digest.length !== 64) {
    return false;
  }
  if (!verifyReleaseBinding(minisig, assetName, publicKeyBase64)) {
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
  assetName: string | undefined,
  publicKeyBase64?: string,
): boolean {
  return verifyReleaseDigest(
    createReleaseDigest().update(bytes).digest(),
    minisig,
    assetName,
    publicKeyBase64,
  );
}
