import { createHash, generateKeyPairSync, sign } from "node:crypto";

/**
 * A throwaway minisign identity for tests that feed the browser's release
 * verifier (cloud-frontend/src/lib/release-signing.ts): the raw public key
 * to hand overrideReleaseSigningKeyForTests, and a signer that writes the
 * .minisig text `minisign -S -H` would for some bytes.
 */
export function testSigningKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  const rawPublicKey = Buffer.from(spki.subarray(spki.length - 32));
  return {
    publicKeyBase64: rawPublicKey.toString("base64"),
    minisigFor(bytes: Uint8Array, { badKeyId = false } = {}): string {
      const digest = createHash("blake2b512").update(bytes).digest();
      const signature = sign(null, digest, privateKey);
      const keyId = Buffer.from(badKeyId ? "ffffffffffffffff" : "27c4c7f5df300370", "hex");
      const blob = Buffer.concat([Buffer.from("ED"), keyId, signature]);
      return [
        "untrusted comment: signature from minisign secret key",
        blob.toString("base64"),
        "trusted comment: timestamp:1757400000\tfile:frameos.img.gz\thashed",
        Buffer.alloc(64, 1).toString("base64"),
        "",
      ].join("\n");
    },
  };
}
