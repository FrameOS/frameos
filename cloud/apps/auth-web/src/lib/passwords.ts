import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// scrypt parameters follow the OWASP interactive-login recommendation
// (N=2^16, r=8, p=1, ~64 MiB per hash). They are recorded in every stored
// hash so they can be raised later without invalidating existing credentials.
const scryptN = 2 ** 16;
const scryptR = 8;
const scryptP = 1;
const keyLength = 64;
const saltLength = 16;

export const passwordPolicy = {
  maxLength: 256,
  minLength: 8,
};

export function validatePasswordCandidate(password: string) {
  if (password.length < passwordPolicy.minLength) {
    return `Password must be at least ${passwordPolicy.minLength} characters long.`;
  }
  if (password.length > passwordPolicy.maxLength) {
    return `Password must be at most ${passwordPolicy.maxLength} characters long.`;
  }
  return undefined;
}

function scryptAsync(
  password: string,
  salt: Buffer,
  options: { N: number; p: number; r: number },
) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password,
      salt,
      keyLength,
      { ...options, maxmem: 256 * 1024 * 1024 },
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(derivedKey);
      },
    );
  });
}

export async function hashPassword(password: string) {
  const salt = randomBytes(saltLength);
  const derived = await scryptAsync(password, salt, {
    N: scryptN,
    p: scryptP,
    r: scryptR,
  });
  return [
    "scrypt",
    String(scryptN),
    String(scryptR),
    String(scryptP),
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(password: string, storedHash: string) {
  const [scheme, rawN, rawR, rawP, encodedSalt, encodedHash] =
    storedHash.split("$");
  if (scheme !== "scrypt" || !rawN || !rawR || !rawP || !encodedSalt || !encodedHash) {
    return false;
  }

  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }

  const expected = Buffer.from(encodedHash, "base64url");
  if (expected.byteLength !== keyLength) {
    return false;
  }

  const derived = await scryptAsync(
    password,
    Buffer.from(encodedSalt, "base64url"),
    { N, p, r },
  );
  return timingSafeEqual(derived, expected);
}

// Hash used when the login email does not resolve to an account, so a failed
// lookup costs the same as a failed password check and response timing does
// not reveal whether an email is registered.
let dummyHashPromise: Promise<string> | undefined;

export async function verifyPasswordWithDummyFallback(
  password: string,
  storedHash: string | null | undefined,
) {
  if (storedHash) {
    return verifyPassword(password, storedHash);
  }

  dummyHashPromise ??= hashPassword(randomBytes(16).toString("base64url"));
  await verifyPassword(password, await dummyHashPromise);
  return false;
}
