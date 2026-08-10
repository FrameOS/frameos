import { hkdfSync } from "node:crypto";
import { getSessionSecret } from "./env";

// Derive a distinct signing key per token purpose from SESSION_SECRET so a
// token minted for one purpose can never verify as another, even if payload
// shape checks regress.
export function derivedSigningKey(purpose: string) {
  return new Uint8Array(
    hkdfSync(
      "sha256",
      getSessionSecret(),
      "frameos-cloud-keys-v1",
      purpose,
      32,
    ),
  );
}
