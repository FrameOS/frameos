// A stand-in for appleid.apple.com's three endpoints, for the Sign in with
// Apple tests (src/lib/apple-sign-in.ts): a real HTTP server, so the code
// under test makes its real requests. It checks what Apple checks (the
// client secret's ES256 signature, issuer, subject and audience; a code is
// spent once and only by the client it was issued to) and signs id_tokens
// with its own RS256 key, served at /auth/keys.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  jwtVerify,
  SignJWT,
  type JWK,
} from "jose";

export type AppleFakePerson = {
  email?: string | undefined;
  emailVerified?: boolean | undefined;
  isPrivateEmail?: boolean | undefined;
  sub: string;
};

type IssuedCode = AppleFakePerson & { clientId: string; nonce?: string | undefined };

export type AppleFake = {
  // The env the code under test reads (getAppleSignInConfig).
  env: Record<string, string>;
  // An authorization code for this person, as Apple would hand the app (no
  // nonce in the exchanged token) or the web callback (the flow's nonce).
  issueCode(person: AppleFakePerson, options: { clientId: string; nonce?: string }): string;
  // An identity token, as the app's sheet hands it over.
  identityToken(
    person: AppleFakePerson,
    options: { audience: string; nonce?: string; issuer?: string },
  ): Promise<string>;
  revoked: { clientId: string; token: string }[];
  url: string;
  close(): Promise<void>;
};

const teamId = "TEAMID1234";
const keyId = "KEYID56789";

export async function startAppleFake(): Promise<AppleFake> {
  const clientKeys = await generateKeyPair("ES256", { extractable: true });
  const appleKeys = await generateKeyPair("RS256", { extractable: true });
  const jwk: JWK = { ...(await exportJWK(appleKeys.publicKey)), alg: "RS256", kid: "fake-apple-1", use: "sig" };
  const codes = new Map<string, IssuedCode>();
  const revoked: { clientId: string; token: string }[] = [];
  let counter = 0;
  let url = "";

  async function sign(person: AppleFakePerson, audience: string, nonce: string | undefined, issuer = url) {
    const claims: Record<string, unknown> = {
      email: person.email,
      email_verified: person.emailVerified === undefined ? undefined : String(person.emailVerified),
      is_private_email: person.isPrivateEmail === undefined ? undefined : String(person.isPrivateEmail),
      nonce,
    };
    for (const key of Object.keys(claims)) {
      if (claims[key] === undefined) delete claims[key];
    }
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: jwk.kid! })
      .setIssuer(issuer)
      .setSubject(person.sub)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(appleKeys.privateKey);
  }

  async function clientSecretOk(clientId: string, secret: string | null) {
    if (!secret) return false;
    try {
      const { payload, protectedHeader } = await jwtVerify(secret, clientKeys.publicKey, {
        algorithms: ["ES256"],
        audience: url,
        issuer: teamId,
        subject: clientId,
      });
      return protectedHeader.kid === keyId && typeof payload.exp === "number";
    } catch {
      return false;
    }
  }

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      void (async () => {
        const reply = (status: number, body: unknown) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(body));
        };
        const path = new URL(request.url ?? "/", url).pathname;
        if (request.method === "GET" && path === "/auth/keys") {
          return reply(200, { keys: [jwk] });
        }
        const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        const clientId = form.get("client_id") ?? "";
        if (request.method === "POST" && path === "/auth/token") {
          if (!(await clientSecretOk(clientId, form.get("client_secret")))) {
            return reply(400, { error: "invalid_client" });
          }
          const code = form.get("code") ?? "";
          const issued = codes.get(code);
          codes.delete(code); // spent, whatever happens next
          if (!issued || issued.clientId !== clientId || form.get("grant_type") !== "authorization_code") {
            return reply(400, { error: "invalid_grant" });
          }
          return reply(200, {
            access_token: `access-${code}`,
            expires_in: 3600,
            id_token: await sign(issued, clientId, issued.nonce),
            refresh_token: `refresh-${code}`,
            token_type: "Bearer",
          });
        }
        if (request.method === "POST" && path === "/auth/revoke") {
          if (!(await clientSecretOk(clientId, form.get("client_secret")))) {
            return reply(400, { error: "invalid_client" });
          }
          revoked.push({ clientId, token: form.get("token") ?? "" });
          response.writeHead(200);
          return response.end();
        }
        reply(404, { error: "not_found" });
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    env: {
      APPLE_APP_BUNDLE_ID: "net.frameos.app",
      APPLE_AUTH_URL: url,
      APPLE_SERVICES_ID: "net.frameos.cloud.test",
      APPLE_SIGN_IN_KEY_ID: keyId,
      APPLE_SIGN_IN_PRIVATE_KEY: await exportPKCS8(clientKeys.privateKey),
      APPLE_TEAM_ID: teamId,
    },
    identityToken: (person, options) => sign(person, options.audience, options.nonce, options.issuer),
    issueCode(person, options) {
      counter += 1;
      const code = `code-${counter}-${Math.random().toString(36).slice(2)}`;
      codes.set(code, { ...person, clientId: options.clientId, nonce: options.nonce });
      return code;
    },
    revoked,
    url,
  };
}
