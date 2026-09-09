import { generateKeyPairSync, sign as signDigest } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createReleaseDigest,
  parseMinisigSignature,
  releaseSigningPublicKeyBase64,
  verifyReleaseBytes,
  verifyReleaseDigest,
} from "./release-signing";

const repoRoot = path.resolve(__dirname, "..", "..", "..", "..", "..");

// A minisign-shaped signature file for `bytes` under a throwaway key: the
// same wire format tools/sign_firmware.py writes (prehashed "ED" mode).
function signAsMinisig(bytes: Uint8Array) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const digest = createReleaseDigest().update(bytes).digest();
  const signature = signDigest(null, digest, privateKey);
  const keyId = Buffer.alloc(8, 0x27);
  const blob = Buffer.concat([Buffer.from("ED", "latin1"), keyId, signature]);
  const rawPublicKey = publicKey
    .export({ format: "der", type: "spki" })
    .subarray(12)
    .toString("base64");
  const minisig =
    "untrusted comment: signature from a test key\n" +
    `${blob.toString("base64")}\n` +
    "trusted comment: timestamp:1\n" +
    `${Buffer.alloc(64, 1).toString("base64")}\n`;
  return { minisig, rawPublicKey, signature };
}

describe("release signing", () => {
  it("carries the same key as the device runtime", () => {
    // The one source of truth is the Nim constant every Pi verifies OTA
    // archives with; the backend pins its Python copy the same way.
    const nim = readFileSync(
      path.join(repoRoot, "frameos", "src", "frameos", "ota_pubkey.nim"),
      "utf8",
    );
    const match = /OtaSigningPublicKeyBase64\*\s*=\s*"([^"]+)"/.exec(nim);
    expect(match?.[1]).toBe(releaseSigningPublicKeyBase64);
    expect(Buffer.from(releaseSigningPublicKeyBase64, "base64")).toHaveLength(32);
  });

  it("parses the signature line and ignores the comments", () => {
    const bytes = new Uint8Array(1000).fill(0xab);
    const { minisig, signature } = signAsMinisig(bytes);
    expect(parseMinisigSignature(minisig)).toEqual(signature);
    expect(parseMinisigSignature("untrusted comment: nothing\n")).toBeUndefined();
    expect(parseMinisigSignature("not base64 at all!\n")).toBeUndefined();
    // Right length, wrong mode marker (a legacy non-prehashed signature).
    const legacy = Buffer.concat([Buffer.from("Ed"), Buffer.alloc(72)]);
    expect(parseMinisigSignature(legacy.toString("base64"))).toBeUndefined();
  });

  it("verifies a good signature and refuses a tampered image or key", () => {
    const bytes = new Uint8Array(5000).map((_, i) => i % 251);
    const { minisig, rawPublicKey } = signAsMinisig(bytes);
    expect(verifyReleaseBytes(bytes, minisig, rawPublicKey)).toBe(true);

    const tampered = bytes.slice();
    tampered[123] = (tampered[123] ?? 0) ^ 0x01;
    expect(verifyReleaseBytes(tampered, minisig, rawPublicKey)).toBe(false);
    // Signed by a key that is not the release key.
    expect(verifyReleaseBytes(bytes, minisig)).toBe(false);
    // A digest of the wrong size can never verify.
    expect(verifyReleaseDigest(new Uint8Array(32), minisig, rawPublicKey)).toBe(false);
    expect(verifyReleaseDigest(new Uint8Array(64), "garbage", rawPublicKey)).toBe(false);
  });
});
