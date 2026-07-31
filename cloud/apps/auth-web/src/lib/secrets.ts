import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { getEncryptionKey } from "./env";

const encryptionVersion = "v1";

export function createSecretToken(prefix: string, byteLength = 32) {
  return `${prefix}_${base64Url(randomBytes(byteLength))}`;
}

export function hashSecret(secret: string) {
  return createHash("sha256").update(secret).digest("base64url");
}

export function encryptSecret(secret: string, key = getEncryptionKey()) {
  const keyBytes = parseEncryptionKey(key);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes, iv);
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    encryptionVersion,
    base64Url(iv),
    base64Url(tag),
    base64Url(ciphertext),
  ].join(":");
}

export function createEncryptedSecretToken(
  prefix: string,
  key = getEncryptionKey(),
) {
  const token = createSecretToken(prefix, 40);
  return {
    encryptedToken: encryptSecret(token, key),
    token,
    tokenReference: hashSecret(token),
  };
}

export function decryptSecret(
  encryptedSecret: string,
  key = getEncryptionKey(),
) {
  const [version, encodedIv, encodedTag, encodedCiphertext] =
    encryptedSecret.split(":");
  if (
    version !== encryptionVersion ||
    !encodedIv ||
    !encodedTag ||
    !encodedCiphertext
  ) {
    throw new Error("Unsupported encrypted secret format");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    parseEncryptionKey(key),
    Buffer.from(encodedIv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function parseEncryptionKey(key: string) {
  const trimmed = key.trim();

  // Validate the format strictly before decoding: Buffer.from silently skips
  // invalid characters, so a corrupted value could otherwise "decode" to a
  // wrong-but-32-byte key and encrypt data that can never be decrypted again.
  if (/^[A-Za-z0-9+/]{43}=?$/.test(trimmed)) {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.byteLength === 32) {
      return decoded;
    }
  }

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  throw new Error(
    "FRAMEOS_CLOUD_ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32) or hex-encoded (openssl rand -hex 32)",
  );
}

function base64Url(bytes: Buffer) {
  return bytes.toString("base64url");
}
