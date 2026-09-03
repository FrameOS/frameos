// Where the wasm runtime the cloud serves comes from.
//
// The runtime (frameos.js / frameos.wasm / preview-worker.js) is the
// interpreter frames run, compiled to WebAssembly. Frames run the last
// release; a preview that renders with a runtime built from `main` shows
// features the frame's firmware does not have yet — one skew shipped a scene
// that previewed fine and painted "No image provided" on the panel. So the
// cloud does not build the runtime: it installs the one the release job
// built, signed and attached to the GitHub release (frameos-<v>-wasm.tar.gz
// + .minisig, signed with the firmware key in release-assets/), pinned by
// the release version in the repo's versions.json — the one place the
// release bump already updates. A new interpreter feature reaches the
// browser preview with the next release, exactly when it reaches frames.
//
// FRAMEOS_WASM_SOURCE=local is the development escape hatch: use the
// workspace package's own build (frameos/wasm/dist/assets, from
// `turbo run build:runtime --filter=frameos-wasm`) — for working on the
// Nim runtime itself, or when there is no network.
/* global Buffer, console, fetch, process */
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const runtimeFiles = ["frameos.js", "frameos.wasm", "preview-worker.js"];
// Shipped by build_wasm.sh next to the bundle; older release tarballs may
// not carry it, so it is optional everywhere it is read.
export const runtimeStampFile = "version.json";

const appDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const repoRoot = dirname(dirname(dirname(appDir)));

export const defaultReleaseRepo = "FrameOS/frameos";

/** The release version the cloud pins its runtime to: the `docker` entry of
 * the repo's versions.json (the release tag is v<that>), without the hash. */
export function pinnedReleaseVersion(versionsPath = join(repoRoot, "versions.json")) {
  const versions = JSON.parse(readFileSync(versionsPath, "utf8"));
  const version = String(versions.docker ?? "").split("+")[0];
  if (!/^\d{4}\.\d{1,2}\.\d+$/.test(version)) {
    throw new Error(`versions.json has no usable release version (docker: ${versions.docker})`);
  }
  return version;
}

export function releaseAssetName(version) {
  return `frameos-${version}-wasm.tar.gz`;
}

export function releaseAssetUrl(version, repo = defaultReleaseRepo) {
  return `https://github.com/${repo}/releases/download/v${version}/${releaseAssetName(version)}`;
}

// --- minisign (as tools/sign_firmware.py writes it) ------------------------
//
// Public key file: "untrusted comment: …" then base64("Ed" + keyId8 + pub32).
// Signature file: untrusted comment, base64("ED" + keyId8 + sig64), trusted
// comment, base64(globalSig64). "ED" is minisign's pre-hashed mode: the
// Ed25519 message is BLAKE2b-512 of the file; the global signature covers
// sig64 + the trusted comment text.

function decodeKeyLine(text, label) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("untrusted comment:") && !line.startsWith("trusted comment:"));
  if (lines.length === 0) {
    throw new Error(`${label}: no key material`);
  }
  return lines;
}

export function parseMinisignPublicKey(text) {
  const [line] = decodeKeyLine(text, "public key");
  const blob = Buffer.from(line, "base64");
  if (blob.length !== 42 || blob.subarray(0, 2).toString("latin1") !== "Ed") {
    throw new Error("public key blob must be base64(Ed + keyid8 + pubkey32)");
  }
  return { keyId: blob.subarray(2, 10), publicKey: blob.subarray(10, 42) };
}

export function parseMinisignSignature(text) {
  const lines = decodeKeyLine(text, "signature");
  const blob = Buffer.from(lines[0], "base64");
  if (blob.length !== 74 || blob.subarray(0, 2).toString("latin1") !== "ED") {
    throw new Error("signature blob must be base64(ED + keyid8 + signature64)");
  }
  const trusted = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("trusted comment:"));
  return {
    keyId: blob.subarray(2, 10),
    signature: blob.subarray(10, 74),
    trustedComment: trusted ? trusted.slice("trusted comment:".length).trim() : null,
    globalSignature: lines[1] ? Buffer.from(lines[1], "base64") : null,
  };
}

// Node wants an SPKI key object; this is the DER prefix for a raw Ed25519 key.
const ed25519SpkiPrefix = Buffer.from("302a300506032b6570032100", "hex");

function ed25519Verify(publicKey, message, signature) {
  const key = createPublicKey({
    key: Buffer.concat([ed25519SpkiPrefix, publicKey]),
    format: "der",
    type: "spki",
  });
  return cryptoVerify(null, message, key, signature);
}

/** Throws unless `fileBytes` carries a valid minisign signature from the key. */
export function verifyMinisign({ publicKeyText, signatureText, fileBytes, label = "file" }) {
  const pub = parseMinisignPublicKey(publicKeyText);
  const sig = parseMinisignSignature(signatureText);
  if (!sig.keyId.equals(pub.keyId)) {
    throw new Error(`${label}: signature key id ${sig.keyId.toString("hex")} does not match the release key ${pub.keyId.toString("hex")}`);
  }
  const digest = createHash("blake2b512").update(fileBytes).digest();
  if (!ed25519Verify(pub.publicKey, digest, sig.signature)) {
    throw new Error(`${label}: signature does not verify against the release key`);
  }
  if (sig.globalSignature && sig.trustedComment !== null) {
    const message = Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, "utf8")]);
    if (!ed25519Verify(pub.publicKey, message, sig.globalSignature)) {
      throw new Error(`${label}: trusted comment does not verify against the release key`);
    }
  }
  return { keyId: pub.keyId.toString("hex"), trustedComment: sig.trustedComment };
}

// --- fetching + unpacking --------------------------------------------------

async function download(url, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`GET ${url} -> HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function extractedRuntimeDir(dir) {
  // The release tarball holds the files at its top level; tolerate one
  // wrapping directory so a hand-made tarball works too.
  if (runtimeFiles.every((file) => existsSync(join(dir, file)))) {
    return dir;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && runtimeFiles.every((file) => existsSync(join(dir, entry.name, file)))) {
      return join(dir, entry.name);
    }
  }
  throw new Error(`the runtime tarball does not contain ${runtimeFiles.join(", ")}`);
}

/**
 * Downloads (once) and verifies the release's wasm runtime, unpacks it, and
 * returns the directory holding frameos.js / frameos.wasm / preview-worker.js
 * (+ version.json). The signature is re-checked on every call, cached or not:
 * the cache is a convenience, the key is the trust.
 */
export async function installReleaseRuntime({
  version = pinnedReleaseVersion(),
  repo = process.env.FRAMEOS_WASM_RELEASE_REPO || defaultReleaseRepo,
  cacheDir = join(appDir, "node_modules", ".cache", "frameos-wasm"),
  publicKeyPath = join(repoRoot, "release-assets", "firmware-signing.pub"),
  fetchImpl = fetch,
  log = console.log,
} = {}) {
  const versionDir = join(cacheDir, version);
  const tarball = join(versionDir, releaseAssetName(version));
  const signature = `${tarball}.minisig`;
  const url = releaseAssetUrl(version, repo);
  mkdirSync(versionDir, { recursive: true });

  if (!existsSync(tarball) || !existsSync(signature)) {
    log(`Downloading the FrameOS ${version} wasm runtime from ${url}`);
    let bytes;
    let sigBytes;
    try {
      bytes = await download(url, { fetchImpl });
      sigBytes = await download(`${url}.minisig`, { fetchImpl });
    } catch (error) {
      throw new Error(
        `Could not fetch the wasm runtime for release ${version} (${error.message}). ` +
          `If the release is still being published, retry in a few minutes; ` +
          `to build the runtime locally instead, set FRAMEOS_WASM_SOURCE=local.`,
      );
    }
    writeFileSync(tarball, bytes);
    writeFileSync(signature, sigBytes);
  }

  const publicKeyText = readFileSync(publicKeyPath, "utf8");
  const verified = verifyMinisign({
    publicKeyText,
    signatureText: readFileSync(signature, "utf8"),
    fileBytes: readFileSync(tarball),
    label: releaseAssetName(version),
  });

  const extractDir = join(versionDir, "runtime");
  rmSync(extractDir, { force: true, recursive: true });
  mkdirSync(extractDir, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", extractDir], { stdio: "inherit" });
  const dir = extractedRuntimeDir(extractDir);
  const stamp = readRuntimeStamp(dir);
  log(
    `Verified the FrameOS ${version} wasm runtime (key ${verified.keyId}` +
      (stamp?.version ? `, interpreter ${stamp.version}` : "") +
      `)`,
  );
  return dir;
}

/** The version.json shipped next to the bundle, or null when absent. */
export function readRuntimeStamp(dir) {
  const path = join(dir, runtimeStampFile);
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** The workspace package's own build (FRAMEOS_WASM_SOURCE=local). */
export function localRuntimeDir() {
  const require = createRequire(join(appDir, "package.json"));
  return dirname(require.resolve("frameos-wasm/assets/preview-worker.js"));
}

/**
 * The directory the copy scripts install from, per FRAMEOS_WASM_SOURCE:
 * "release" (default) or "local".
 */
export async function resolveRuntimeDir({ env = process.env, log = console.log } = {}) {
  const source = (env.FRAMEOS_WASM_SOURCE || "release").trim();
  if (source === "local") {
    const dir = localRuntimeDir();
    log(`Using the locally built wasm runtime from ${dir} (FRAMEOS_WASM_SOURCE=local)`);
    return dir;
  }
  if (source !== "release") {
    throw new Error(`FRAMEOS_WASM_SOURCE must be "release" or "local", not "${source}"`);
  }
  return installReleaseRuntime({ log });
}

/** Files to copy out of a runtime dir: the bundle plus the stamp when present. */
export function runtimeFilesIn(dir) {
  return existsSync(join(dir, runtimeStampFile)) ? [...runtimeFiles, runtimeStampFile] : runtimeFiles;
}
