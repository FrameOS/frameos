import { generateKeyPairSync, sign as signDigest } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createReleaseDigest,
  parseMinisig,
  parseMinisigSignature,
  releaseAssetName,
  releaseSigningPublicKeyBase64,
  verifyReleaseBinding,
  verifyReleaseBytes,
  verifyReleaseDigest,
} from "./release-signing";

const repoRoot = path.resolve(__dirname, "..", "..", "..", "..", "..");

// A minisign-shaped signature file for `bytes` under a throwaway key: the
// same wire format tools/sign_firmware.py writes (prehashed "ED" mode).
const assetName = "frameos-2026.9.20-raspberry-pi-64-buildroot.img.gz";

// The .minisig the release workflow published beside
// frameos-2026.9.19-debian-bookworm-arm64.tar.gz, signed by the production
// key: the same fixture the Nim, C and Python verifiers are held to.
const realAsset = "frameos-2026.9.19-debian-bookworm-arm64.tar.gz";
const realMinisig = [
  "untrusted comment: signature from FrameOS firmware key",
  "RUQnxMf13zADcFFcQyFKSGSP8dlnMFEnZtwiPYna8r7uZj3THgXiAyf55UahO6vTTswZUqCwN9/E/UsA5X9OcUiuBsjcK/nDeww=",
  "trusted comment: frameos frameos-2026.9.19-debian-bookworm-arm64.tar.gz",
  "uzpKdt8H7PSIz+P45GNmLUyI6GI3VVaytR4nGc7yjYeQMSns8swLi35Bf6rObL2ckov4/B+11BuzuTcHU+TsDg==",
  "",
].join("\n");

function signAsMinisig(bytes: Uint8Array, signedAs = assetName) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const digest = createReleaseDigest().update(bytes).digest();
  const signature = signDigest(null, digest, privateKey);
  const keyId = Buffer.alloc(8, 0x27);
  const blob = Buffer.concat([Buffer.from("ED", "latin1"), keyId, signature]);
  const rawPublicKey = publicKey
    .export({ format: "der", type: "spki" })
    .subarray(12)
    .toString("base64");
  const comment = `frameos ${signedAs}`;
  const globalSignature = signDigest(
    null,
    Buffer.concat([signature, Buffer.from(comment, "utf8")]),
    privateKey,
  );
  const minisig =
    "untrusted comment: signature from a test key\n" +
    `${blob.toString("base64")}\n` +
    `trusted comment: ${comment}\n` +
    `${globalSignature.toString("base64")}\n`;
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

  it("parses the signature, the trusted comment and the global signature", () => {
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
    expect(verifyReleaseBytes(bytes, minisig, assetName, rawPublicKey)).toBe(true);

    const tampered = bytes.slice();
    tampered[123] = (tampered[123] ?? 0) ^ 0x01;
    expect(verifyReleaseBytes(tampered, minisig, assetName, rawPublicKey)).toBe(false);
    // Signed by a key that is not the release key.
    expect(verifyReleaseBytes(bytes, minisig, assetName)).toBe(false);
    // A digest of the wrong size can never verify.
    expect(verifyReleaseDigest(new Uint8Array(32), minisig, assetName, rawPublicKey)).toBe(false);
    expect(verifyReleaseDigest(new Uint8Array(64), "garbage", assetName, rawPublicKey)).toBe(false);
  });

  it("accepts a signature only for the asset it names", () => {
    // docs/security-todo.md, "OTA signature binds archive bytes only".
    const bytes = new Uint8Array(3000).map((_, i) => i % 199);
    const { minisig, rawPublicKey } = signAsMinisig(bytes);
    for (const other of [
      "frameos-2026.9.21-raspberry-pi-64-buildroot.img.gz", // replayed as a newer release
      "frameos-2026.9.20-raspberry-pi-32-buildroot.img.gz", // another board
      `${assetName}.evil`,
      "",
      undefined,
    ]) {
      expect(verifyReleaseBinding(minisig, other, rawPublicKey)).toBe(false);
      expect(verifyReleaseBytes(bytes, minisig, other, rawPublicKey)).toBe(false);
    }
    // Rewriting the comment to match breaks the global signature.
    const rewritten = minisig.replace("2026.9.20", "2026.9.21");
    expect(
      verifyReleaseBinding(
        rewritten,
        "frameos-2026.9.21-raspberry-pi-64-buildroot.img.gz",
        rawPublicKey,
      ),
    ).toBe(false);
  });

  it("holds a real release signature to the production key", () => {
    expect(parseMinisig(realMinisig)?.trustedComment).toBe(`frameos ${realAsset}`);
    expect(verifyReleaseBinding(realMinisig, realAsset)).toBe(true);
    expect(verifyReleaseBinding(realMinisig.replace(/\n/g, "\r\n"), realAsset)).toBe(true);
    expect(
      verifyReleaseBinding(realMinisig, "frameos-2026.9.20-debian-bookworm-arm64.tar.gz"),
    ).toBe(false);
    expect(
      verifyReleaseBinding(
        realMinisig.replace(/2026\.9\.19/g, "2026.9.20"),
        "frameos-2026.9.20-debian-bookworm-arm64.tar.gz",
      ),
    ).toBe(false);
  });

  it("refuses a signature with no signed comment rather than calling it legacy", () => {
    const lines = realMinisig.split("\n");
    expect(parseMinisig(lines.slice(0, 2).join("\n"))).toBeUndefined();
    expect(parseMinisig(lines.slice(0, 3).join("\n"))).toBeUndefined();
    expect(parseMinisig([...lines.slice(0, 3), "AAAA"].join("\n"))).toBeUndefined();
    expect(
      parseMinisig([...lines.slice(0, 3), lines[2], lines[3]].join("\n")),
    ).toBeUndefined();
  });

  it("builds the expected asset name from the release tag", () => {
    expect(releaseAssetName("v2026.9.19", "raspberry-pi-64-buildroot.img.gz")).toBe(
      "frameos-2026.9.19-raspberry-pi-64-buildroot.img.gz",
    );
    expect(releaseAssetName(undefined, "x")).toBeUndefined();
    expect(releaseAssetName("v1.2.3/../evil", "x")).toBeUndefined();
  });
});
