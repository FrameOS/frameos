import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  Blake2b512,
  RELEASE_SIGNING_PUBLIC_KEY_BASE64,
  ReleaseSignatureError,
  hashingTransform,
  overrideReleaseSigningKeyForTests,
  parseMinisigSignature,
  verifyReleaseDigest,
} from "../../../../../../cloud-frontend/src/lib/release-signing";
import { testSigningKey } from "./fixtures/releaseSigning";

// The browser SD image builder verifies the release image it downloads the
// way every other reader of a release asset does (the devices, the backend,
// the install script): BLAKE2b-512 over the file, Ed25519 over the digest,
// against the one release key. Three things are pinned here: the key is the
// device runtime's, the vendored BLAKE2b is BLAKE2b, and the minisig parser
// and verifier agree with minisign.

const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url));

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

afterEach(() => {
  overrideReleaseSigningKeyForTests(undefined);
});

describe("the release signing key", () => {
  it("is the device runtime's OTA key, byte for byte", () => {
    const nim = readFileSync(`${repoRoot}frameos/src/frameos/ota_pubkey.nim`, "utf8");
    const match = /OtaSigningPublicKeyBase64\*\s*=\s*"([^"]+)"/.exec(nim);
    expect(match, "ota_pubkey.nim no longer defines OtaSigningPublicKeyBase64").toBeTruthy();
    expect(RELEASE_SIGNING_PUBLIC_KEY_BASE64).toBe(match![1]);
    expect(Buffer.from(RELEASE_SIGNING_PUBLIC_KEY_BASE64, "base64")).toHaveLength(32);
  });

  it("matches the key the install script and the backend carry", () => {
    // scripts/frameos-setup.sh holds the SPKI wrapping; the backend the raw
    // key. Both derive from the same 32 bytes.
    const script = readFileSync(`${repoRoot}scripts/frameos-setup.sh`, "utf8");
    const spki = /FRAMEOS_RELEASE_SIGNING_KEY_SPKI="([^"]+)"/.exec(script);
    expect(spki).toBeTruthy();
    const spkiBytes = Buffer.from(spki![1]!, "base64");
    expect(spkiBytes.subarray(12).toString("base64")).toBe(RELEASE_SIGNING_PUBLIC_KEY_BASE64);
    const backend = readFileSync(`${repoRoot}backend/app/utils/release_signing.py`, "utf8");
    expect(backend).toContain(`RELEASE_SIGNING_PUBLIC_KEY_BASE64 = "${RELEASE_SIGNING_PUBLIC_KEY_BASE64}"`);
  });
});

describe("Blake2b512", () => {
  it("matches the RFC 7693 test vectors", () => {
    expect(hex(new Blake2b512().digest())).toBe(
      "786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce",
    );
    expect(hex(new Blake2b512().update(new TextEncoder().encode("abc")).digest())).toBe(
      "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
    );
  });

  it("agrees with node's blake2b512 however the input is chunked", () => {
    const input = new Uint8Array(300_007);
    let state = 42;
    for (let index = 0; index < input.length; index++) {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      input[index] = (state >> 16) & 0xff;
    }
    const expected = createHash("blake2b512").update(input).digest("hex");
    for (const chunkSize of [1, 127, 128, 129, 1000, 65536, input.length]) {
      const hasher = new Blake2b512();
      for (let offset = 0; offset < input.length; offset += chunkSize) {
        hasher.update(input.subarray(offset, offset + chunkSize));
      }
      expect(hex(hasher.digest()), `chunk size ${chunkSize}`).toBe(expected);
    }
    // Exactly one block and exactly two: the "compress only when more input
    // arrives" boundary.
    for (const length of [128, 256]) {
      expect(hex(new Blake2b512().update(input.subarray(0, length)).digest())).toBe(
        createHash("blake2b512").update(input.subarray(0, length)).digest("hex"),
      );
    }
  });

  it("hashes a stream as it passes through", async () => {
    const hasher = new Blake2b512();
    const parts = [new Uint8Array([1, 2, 3]), new Uint8Array(200).fill(7)];
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) {
          controller.enqueue(part);
        }
        controller.close();
      },
    });
    const seen: number[] = [];
    const reader = source.pipeThrough(hashingTransform(hasher)).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      seen.push(value.length);
    }
    expect(seen).toEqual([3, 200]);
    expect(hex(hasher.digest())).toBe(
      createHash("blake2b512").update(Buffer.concat(parts)).digest("hex"),
    );
  });
});

describe("minisig verification", () => {
  const asset = new TextEncoder().encode("release bytes ".repeat(1000));

  it("accepts a signature the release key made, from the file or its bare line", async () => {
    const key = testSigningKey();
    overrideReleaseSigningKeyForTests(key.publicKeyBase64);
    const minisig = key.minisigFor(asset);
    const digest = new Blake2b512().update(asset).digest();
    await expect(verifyReleaseDigest(digest, minisig)).resolves.toBeUndefined();
    await expect(verifyReleaseDigest(digest, minisig.split("\n")[1]!)).resolves.toBeUndefined();
  });

  it("refuses a tampered asset, another key's signature, and a malformed file", async () => {
    const key = testSigningKey();
    overrideReleaseSigningKeyForTests(key.publicKeyBase64);
    const minisig = key.minisigFor(asset);
    const tampered = new Uint8Array(asset);
    tampered[10] = (tampered[10] ?? 0) ^ 1;
    await expect(
      verifyReleaseDigest(new Blake2b512().update(tampered).digest(), minisig),
    ).rejects.toMatchObject({ code: "signature_mismatch" });

    const digest = new Blake2b512().update(asset).digest();
    await expect(
      verifyReleaseDigest(digest, testSigningKey().minisigFor(asset)),
    ).rejects.toMatchObject({ code: "signature_mismatch" });
    // Without the override the pinned production key applies, and this
    // throwaway signature is not from it.
    overrideReleaseSigningKeyForTests(undefined);
    await expect(verifyReleaseDigest(digest, minisig)).rejects.toBeInstanceOf(ReleaseSignatureError);

    expect(() => parseMinisigSignature("untrusted comment: only\n")).toThrow(/no signature line/);
    expect(() => parseMinisigSignature("not base64!!")).toThrow(/not valid base64/);
    expect(() => parseMinisigSignature(Buffer.alloc(74, 0).toString("base64"))).toThrow(/prehashed/);
    expect(() => parseMinisigSignature(Buffer.alloc(70, 0).toString("base64"))).toThrow(/wrong length/);
  });

  it("trusts the key, not the key id or the trusted comment", () => {
    const key = testSigningKey();
    const a = parseMinisigSignature(key.minisigFor(asset));
    const b = parseMinisigSignature(key.minisigFor(asset, { badKeyId: true }));
    expect(a).toHaveLength(64);
    expect(hex(a)).toBe(hex(b));
  });
});
