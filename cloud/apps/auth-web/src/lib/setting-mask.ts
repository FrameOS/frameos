// How a stored secret (an API key, a token) is shown without being shown:
// eight bullets, plus the last four characters when the secret is long
// enough for those to identify it without helping anyone guess the rest.
//
// Pure on purpose — no crypto, no database — so the browser side of the
// settings forms (AccountSettingsForm, the shared SPA) can recognise a
// masked value with the same test the server applies when one is posted
// back: a secret field whose value is a mask means "keep what is stored"
// (app/api/settings/route.ts), which is what lets a form round-trip the
// whole group without ever having held the key.

const maskBullets = "••••••••";

export function maskSettingValue(secret: string): string {
  if (secret === "") {
    return "";
  }
  return secret.length > 8 ? `${maskBullets}${secret.slice(-4)}` : maskBullets;
}

export function isMaskedSettingValue(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(maskBullets);
}
