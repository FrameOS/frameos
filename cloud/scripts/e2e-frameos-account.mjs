// Creates a verified FrameOS Cloud account over HTTP (plus one direct DB
// update to skip the verification email) and prints its session cookie.
// Used by scripts/e2e-frameos.sh to drive the AGPL repo's cloud E2E test.
import { createRequire } from "node:module";

// Resolve the driver through @frameos-cloud/db's dependencies; the scripts
// directory has no node_modules of its own in the pnpm workspace.
const require = createRequire(
  new URL("../packages/db/package.json", import.meta.url),
);
const postgres = require("postgres");

const cloudUrl = process.env.CLOUD_URL ?? "http://localhost:3000";
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://frameos_cloud@127.0.0.1:55432/frameos_cloud";

const email = `e2e-frameos-${process.pid}-${Date.now()}@example.com`;
const password = `E2e-${Date.now()}-frameos!`;

async function postJson(path, body) {
  const response = await fetch(new URL(path, cloudUrl), {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin: cloudUrl },
    method: "POST",
  });
  return response;
}

const signup = await postJson("/api/auth/signup", {
  email,
  name: "FrameOS E2E",
  password,
});
if (!signup.ok) {
  console.error("signup failed:", signup.status, await signup.text());
  process.exit(1);
}

// Dev shortcut: flip the email_verified flag instead of clicking the emailed
// link. Identity rows key accounts; the password identity carries the flag.
const sql = postgres(databaseUrl, { max: 1 });
await sql`
  UPDATE account_identities
  SET email_verified = true
  WHERE email_snapshot = ${email} AND provider_key = 'password'
`;
await sql.end();

const login = await postJson("/api/auth/login", { email, password });
if (!login.ok) {
  console.error("login failed:", login.status, await login.text());
  process.exit(1);
}
const setCookie = login.headers.get("set-cookie") ?? "";
const cookie = setCookie.split(";")[0];
if (!cookie.includes("=")) {
  console.error("no session cookie in login response:", setCookie);
  process.exit(1);
}

process.stdout.write(JSON.stringify({ cookie, email }) + "\n");
