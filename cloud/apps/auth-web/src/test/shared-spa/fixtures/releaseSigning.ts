import { createHash, generateKeyPairSync, sign } from "node:crypto";

/**
 * A throwaway minisign identity for tests that feed the browser's release
 * verifier (cloud-frontend/src/lib/release-signing.ts): the raw public key
 * to hand overrideReleaseSigningKeyForTests, and a signer that writes the
 * .minisig text `minisign -S -H` would for some bytes.
 */
/** The asset name `minisigFor` signs as unless told otherwise. */
export const testAssetName = "frameos-2026.9.20-raspberry-pi-64-buildroot.img.gz";

export function testSigningKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  const rawPublicKey = Buffer.from(spki.subarray(spki.length - 32));
  return {
    publicKeyBase64: rawPublicKey.toString("base64"),
    minisigFor(
      bytes: Uint8Array,
      { badKeyId = false, signedAs = testAssetName }: { badKeyId?: boolean; signedAs?: string } = {},
    ): string {
      const digest = createHash("blake2b512").update(bytes).digest();
      const signature = sign(null, digest, privateKey);
      const keyId = Buffer.from(badKeyId ? "ffffffffffffffff" : "27c4c7f5df300370", "hex");
      const blob = Buffer.concat([Buffer.from("ED"), keyId, signature]);
      // What tools/sign_firmware.py writes: the trusted comment names the
      // asset, the global signature covers signature || comment.
      const comment = `frameos ${signedAs}`;
      const globalSignature = sign(
        null,
        Buffer.concat([signature, Buffer.from(comment, "utf8")]),
        privateKey,
      );
      return [
        "untrusted comment: signature from FrameOS firmware key",
        blob.toString("base64"),
        `trusted comment: ${comment}`,
        globalSignature.toString("base64"),
        "",
      ].join("\n");
    },
  };
}
