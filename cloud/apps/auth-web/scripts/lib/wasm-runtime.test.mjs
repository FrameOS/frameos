// The cloud installs the wasm runtime from a signed release asset; these
// tests pin the two things that make that safe — the signature check is the
// same format tools/sign_firmware.py writes, and the installer refuses a
// tarball the release key did not sign — plus the version pin's source.
/* global Buffer, URL */
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installReleaseRuntime,
  parseMinisignPublicKey,
  pinnedReleaseVersion,
  readRuntimeStamp,
  releaseAssetName,
  releaseAssetUrl,
  runtimeFiles,
  verifyMinisign,
} from "./wasm-runtime.mjs";

// A throwaway Ed25519 key in the layout sign_firmware.py uses: raw 32-byte
// public key behind "Ed" + an 8-byte key id; signatures "ED" + id + sig64.
function makeKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  const raw = spki.subarray(spki.length - 32);
  const keyId = Buffer.from("0102030405060708", "hex");
  const publicKeyText =
    "untrusted comment: test key\n" + Buffer.concat([Buffer.from("Ed"), keyId, raw]).toString("base64") + "\n";
  function signFile(bytes, name) {
    const digest = createHash("blake2b512").update(bytes).digest();
    const signature = cryptoSign(null, digest, privateKey);
    const trusted = `frameos ${name}`;
    const globalSig = cryptoSign(null, Buffer.concat([signature, Buffer.from(trusted)]), privateKey);
    return (
      "untrusted comment: signature from FrameOS firmware key\n" +
      Buffer.concat([Buffer.from("ED"), keyId, signature]).toString("base64") +
      "\n" +
      `trusted comment: ${trusted}\n` +
      globalSig.toString("base64") +
      "\n"
    );
  }
  return { publicKeyText, signFile, keyId };
}

describe("minisign verification", () => {
  it("accepts a signature from the key, over the file's BLAKE2b-512 digest", () => {
    const key = makeKey();
    const bytes = Buffer.from("hello runtime");
    const result = verifyMinisign({
      publicKeyText: key.publicKeyText,
      signatureText: key.signFile(bytes, "x.tar.gz"),
      fileBytes: bytes,
    });
    expect(result.keyId).toBe("0102030405060708");
    expect(result.trustedComment).toBe("frameos x.tar.gz");
  });

  it("refuses a tampered file, a foreign key and a forged trusted comment", () => {
    const key = makeKey();
    const other = makeKey();
    const bytes = Buffer.from("hello runtime");
    const signatureText = key.signFile(bytes, "x.tar.gz");
    expect(() =>
      verifyMinisign({ publicKeyText: key.publicKeyText, signatureText, fileBytes: Buffer.from("hello runtimf") }),
    ).toThrow(/does not verify/);
    expect(() => verifyMinisign({ publicKeyText: other.publicKeyText, signatureText, fileBytes: bytes })).toThrow(
      /does not verify/,
    );
    const forged = signatureText.replace("trusted comment: frameos x.tar.gz", "trusted comment: frameos y.tar.gz");
    expect(() => verifyMinisign({ publicKeyText: key.publicKeyText, signatureText: forged, fileBytes: bytes })).toThrow(
      /trusted comment/,
    );
  });

  it("reads the committed release key", () => {
    const text = readFileSync(new URL("../../../../../release-assets/firmware-signing.pub", import.meta.url), "utf8");
    const parsed = parseMinisignPublicKey(text);
    expect(parsed.publicKey.length).toBe(32);
    expect(parsed.keyId.length).toBe(8);
  });
});

describe("release pin", () => {
  it("is the release version in versions.json, without the build hash", () => {
    const dir = mkdtempSync(join(tmpdir(), "frameos-wasm-pin-"));
    writeFileSync(join(dir, "versions.json"), JSON.stringify({ docker: "2026.9.1+abcdef", frameos: "2026.9.0+123" }));
    expect(pinnedReleaseVersion(join(dir, "versions.json"))).toBe("2026.9.1");
    expect(releaseAssetName("2026.9.1")).toBe("frameos-2026.9.1-wasm.tar.gz");
    expect(releaseAssetUrl("2026.9.1")).toBe(
      "https://github.com/FrameOS/frameos/releases/download/v2026.9.1/frameos-2026.9.1-wasm.tar.gz",
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the repo's own versions.json", () => {
    expect(pinnedReleaseVersion()).toMatch(/^\d{4}\.\d{1,2}\.\d+$/);
  });
});

describe("installReleaseRuntime", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "frameos-wasm-install-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeTarball(name) {
    const src = join(dir, "src");
    mkdirSync(src, { recursive: true });
    for (const file of runtimeFiles) {
      writeFileSync(join(src, file), `// ${file}\n`);
    }
    writeFileSync(join(src, "version.json"), JSON.stringify({ version: "2026.9.0", release: "2026.9.1" }));
    const tarball = join(dir, name);
    execFileSync("tar", ["-czf", tarball, "-C", src, ...runtimeFiles, "version.json"]);
    return readFileSync(tarball);
  }

  function fetcher(responses) {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      const body = responses[url];
      if (!body) {
        return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
      }
      return { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
    };
    return { fetchImpl, calls };
  }

  it("downloads, verifies, unpacks, and reuses the cached download", async () => {
    const key = makeKey();
    writeFileSync(join(dir, "key.pub"), key.publicKeyText);
    const name = releaseAssetName("2026.9.1");
    const tarball = makeTarball(name);
    const url = releaseAssetUrl("2026.9.1");
    const { fetchImpl, calls } = fetcher({
      [url]: tarball,
      [`${url}.minisig`]: Buffer.from(key.signFile(tarball, name)),
    });
    const options = {
      version: "2026.9.1",
      cacheDir: join(dir, "cache"),
      publicKeyPath: join(dir, "key.pub"),
      fetchImpl,
      log: () => {},
    };
    const runtimeDir = await installReleaseRuntime(options);
    for (const file of runtimeFiles) {
      expect(readFileSync(join(runtimeDir, file), "utf8")).toBe(`// ${file}\n`);
    }
    expect(readRuntimeStamp(runtimeDir)).toMatchObject({ version: "2026.9.0", release: "2026.9.1" });
    expect(calls).toHaveLength(2);

    await installReleaseRuntime(options);
    expect(calls).toHaveLength(2);
  });

  it("refuses a tarball the release key did not sign, and a missing asset", async () => {
    const key = makeKey();
    const impostor = makeKey();
    writeFileSync(join(dir, "key.pub"), key.publicKeyText);
    const name = releaseAssetName("2026.9.1");
    const tarball = makeTarball(name);
    const url = releaseAssetUrl("2026.9.1");
    const signed = fetcher({
      [url]: tarball,
      [`${url}.minisig`]: Buffer.from(impostor.signFile(tarball, name)),
    });
    await expect(
      installReleaseRuntime({
        version: "2026.9.1",
        cacheDir: join(dir, "cache-a"),
        publicKeyPath: join(dir, "key.pub"),
        fetchImpl: signed.fetchImpl,
        log: () => {},
      }),
    ).rejects.toThrow(/does not verify/);

    const missing = fetcher({});
    await expect(
      installReleaseRuntime({
        version: "2026.9.2",
        cacheDir: join(dir, "cache-b"),
        publicKeyPath: join(dir, "key.pub"),
        fetchImpl: missing.fetchImpl,
        log: () => {},
      }),
    ).rejects.toThrow(/Could not fetch the wasm runtime for release 2026.9.2/);
  });
});
