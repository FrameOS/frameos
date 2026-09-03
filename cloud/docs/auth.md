# First-Party Auth

FrameOS Cloud owns authentication end to end: email/password credentials,
optional Google SSO, sessions, password resets, and the superadmin panel. There
is no external identity provider in the login path.

## Account Model

- `accounts` is the canonical user record (FrameOS-owned UUID, display name,
  `password_hash`, `is_superadmin`).
- `account_identities` maps sign-in methods to accounts, unique on
  `(provider_issuer, provider_subject)`:
  - Password: issuer `frameos-cloud`, key `password`, subject = normalized
    (lowercased) email. This row is what makes an email unique for password
    login; `accounts.primary_email` stays a non-authoritative snapshot.
  - Google: issuer `https://accounts.google.com`, key `google`, subject =
    Google `sub` claim.
- Passwords are hashed with scrypt (`N=2^16, r=8, p=1`, per-hash salt); the
  parameters are stored inside each hash so they can be raised later without
  invalidating existing credentials.

## Flows

- **Signup** — `POST /api/auth/signup` creates the account plus password
  identity and sends a verification email with a hashed single-use token
  valid for 24 hours; the link lands on `/verify-email?token=…`, which flips
  `email_verified` on the password identity. No session is minted at signup:
  the account cannot log in until the email is verified. A failed send never
  fails the signup. Duplicate emails return `email_taken`.
- **Login** — `POST /api/auth/login` verifies the password (with a dummy-hash
  fallback so unknown emails cost the same time as wrong passwords) and mints
  a session. A correct password with an unverified email is refused with
  `email_unverified` and automatically resends the verification link
  (throttled to 3/hour per account). Rate-limited per IP and per target
  email.
- **Logout** — `POST /api/auth/logout` revokes the server-side session row and
  clears cookies.
- **Password reset** — `POST /api/auth/reset/request` always returns 200 (no
  email enumeration) and stores a hashed single-use token valid for one hour;
  the emailed link lands on `/recovery?token=…`, which calls
  `POST /api/auth/reset/confirm`. A successful reset revokes every session for
  the account and also marks the email verified, since following the emailed
  link proves control of the address. Emails go through Postmark when `POSTMARK_SERVER_TOKEN` is set,
  otherwise the link is written to the server log (local development).
- **Google SSO** — `GET /api/auth/google/start` runs a standard OIDC
  Authorization Code + PKCE flow against Google using the shared helpers in
  `@frameos-cloud/auth-client`; `GET /api/auth/google/callback` verifies the
  `id_token` (issuer, audience, nonce, JWKS) and signs the user in.

## Account Merging

One account can carry both sign-in methods; merges are gated on proof of
email ownership to block pre-hijacking:

- **Password first, then Google** — if the password account's email is
  verified and Google attests the same email, the callback does _not_ link
  on Google's word alone: the verified claims are parked in a signed,
  ten-minute `frameos_google_link_pending` cookie and the visitor is sent to
  `/login/link-google`, which asks for the account's password.
  `POST /api/auth/google/link` checks it, links the identity, revokes every
  existing session (a fresh one is minted), emails the owner
  (`google_linked`) and writes `account.google_linked` to the audit log; a
  wrong password is `403 invalid_password` and `account.google_link_failed`.
  From then on both methods sign into the same account. If the password
  account is _unverified_, the Google user is shown a warning and sent
  through the password reset flow first: the emailed link proves the address
  is theirs and evicts any password a squatter may have set. After the reset,
  the same password confirmation connects Google.
- **Google first, then password** — signup with that email is refused
  (`email_taken_google`) so a stranger can never plant a password on the
  account; instead, "Forgot password?" works for Google-first accounts and
  completing it creates a verified password identity on the same account.
- Google identities with a Google-unverified email never participate in
  merging.

Sessions use an HS256 JWT (key derived from `SESSION_SECRET`) in an `httpOnly`
cookie, backed by a revocable `sessions` row keyed on the token hash. In split
production the cookie is `Secure`, uses the `__Secure-` prefix, and is scoped
to `FRAMEOS_SESSION_COOKIE_DOMAIN` so `cloud.frameos.net`,
`account.frameos.net`, and `scenes.frameos.net` see the same login. OAuth
state/nonce cookies stay host-only on the cloud login origin. The non-sensitive
light/dark preference uses a separate script-readable parent-domain cookie so
the theme follows navigation between sites. Local development keeps host-only
cookies because every surface uses the same `http://localhost:3000` origin.

Sessions slide. `sessions.expires_at` is an *idle* deadline (30 days) that the
Next proxy (`apps/auth-web/proxy.ts`) pushes forward as the browser makes
requests, so continuous use never logs anyone out; `sessions.absolute_expires_at`
(90 days) is the ceiling activity can never push past, at which point the user
signs in again. The refresh is throttled by `sessions.last_used_at` to one row
update per session per hour, re-issues the *same* token (rotation would break
in-flight requests and the frame hub's open browser sockets), and re-issues the
cookie with a fresh `Max-Age`. The proxy is the only legal place for it: Next 16
always runs the proxy on the Node.js runtime, while `readSession()` runs inside
React Server Components where `cookies().set()` throws. The row remains the
single enforcement point, so logout, a password change, and the admin "revoke
sessions" button all still take effect on the very next request.

## Two-Factor Authentication (optional)

An account that controls physical frames can add a second step to sign-in. It
is opt-in, managed on `/account/security`, and ON exactly when the account has
a confirmed authenticator-app secret or at least one passkey — the credentials
are the flag (`account_totp`, `account_passkeys`, migration 0034), so nothing
can drift out of sync with them.

- **Authenticator app (TOTP, RFC 6238)** — `POST /api/account/two-factor/totp`
  mints a 160-bit base32 secret (stored AES-256-GCM under
  `FRAMEOS_CLOUD_ENCRYPTION_KEY`) plus an `otpauth://` URI and a server-rendered
  QR SVG; `POST …/totp/confirm` with one valid code flips it on. Codes are six
  digits, 30 s steps, ±1 step of drift, and the accepted step is persisted so a
  captured code cannot be replayed inside its window.
- **Passkeys (WebAuthn)** — `@simplewebauthn/server`; relying-party id is the
  cloud origin's hostname (override with `FRAMEOS_WEBAUTHN_RP_ID` when the
  login and account surfaces sit on different subdomains — set it to the common
  parent domain), expected origins are the configured app origins. Challenges
  are stateless: a signed JWT in an httpOnly cookie, 5 minutes. Registration
  asks for a discoverable, `userVerification: preferred` credential, so the
  same passkey also works as a **passwordless** sign-in ("Sign in with a
  passkey" on `/login`, `POST /api/auth/passkey/{options,verify}`): there user
  verification is *required* and one assertion is the whole sign-in.
- **Recovery codes** — ten single-use `xxxxx-xxxxx` codes, minted when the
  first second factor is confirmed and shown exactly once, stored as keyed
  HMAC hashes (like device user codes); regenerating replaces the set, and they
  are deleted when the last second factor goes.

**Sign-in gate.** Both session-minting routes (`/api/auth/login` and the Google
callback) end in `completeFirstFactor()` (`src/lib/sign-in.ts`). With a second
factor enrolled it mints no session: it sets a 10-minute signed
`frameos_signin_pending` cookie and sends the browser to `/login/verify`, which
offers a passkey (`/api/auth/second-factor/passkey/{options,verify}`) or an
authenticator/recovery code (`/api/auth/second-factor/code`). Only those
routes turn the pending cookie into a real session; the pending token grants
nothing by itself. Everything downstream of a session (device approval,
FrameOS-backend SSO, the frames SPA) is therefore covered without changes.
Code checks are rate-limited per IP and per account (10 / 15 min), and every
failure is audited (`account.second_factor_failed`).

**Strengthening the account** (starting authenticator enrollment,
requesting passkey registration options) needs a recent sign-in (see
re-authentication below) AND, when the account has a password, that password
in the body (`requireStrengtheningProof`, `src/lib/account-security.ts`): a
passkey added with nothing but a stolen cookie would satisfy sudo mode on its
own from then on. The proof is checked at the start of enrollment; the
confirm/attestation steps are bound to what the start minted (the pending
secret, the single-use challenge cookie). Every enrollment emails the owner.

**Weakening the account** (removing the authenticator or a passkey,
regenerating recovery codes, turning 2FA off) re-asks for the password when
the account has one, otherwise for a current authenticator/recovery code
(`requireWeakeningProof`, `src/lib/account-security.ts`). Every change is an
audit event (`account.totp_enabled/disabled`, `account.passkey_added/
removed/renamed`, `account.recovery_codes_regenerated`,
`account.two_factor_disabled`), and `account.signed_in` carries
`second_factor: totp|passkey|recovery_code`.

## Re-authentication for sensitive actions ("sudo mode")

A session cookie is a laptop left open. Actions that change who controls a
device therefore re-check the credentials even with a valid session: every
`sessions` row remembers when it last proved them (`authenticated_at`,
migration 0036 — set at sign-in, pushed forward by a successful re-check),
and the routes below refuse with `403 {"error": "reauth_required", "reauth":
{"methods": …, "path": "/login/reauth", "max_age_seconds": …}}` when that is
older than the route's window (`src/lib/recent-auth.ts`). Two windows,
matched to what the action can do:

- **15 minutes** (`recentAuthMaxAgeSeconds`) for the destructive pair:
  `POST /api/frames/{id}/revoke` (revoking a cloud-managed frame) and
  `POST /api/device/revoke` (revoking a linked backend or frame), for
  `DELETE /api/frames/{id}`, for second-factor enrolment, and for every
  `/api/admin/*` mutation (`getSuperadminContext({ mutation: true })` —
  granting superadmin, deleting an account, posting a journal entry; the
  admin tables follow the 403 to `/login/reauth` like any other button).
  Every `/api/admin/*` route is cookie-only; the nightly accounting job
  does not go through `getSuperadminContext` at all but through its own
  job-token kind (`fc_apijob_…`, `authenticateJobToken`), which opens
  `POST /api/admin/billing/nightly` and nothing else.
- **2 hours** (`recentApprovalMaxAgeSeconds`) for
  `POST /api/device/authorize` — approving a device link or a scope change.
  Approvals are additive and come in batches ("setting up frames this
  afternoon"); the gate still matters because an approval converts a stolen
  cookie into a durable token, but a login fresh that afternoon is proof
  enough. The `/device` page sends a stale session through `/login/reauth`
  *before* showing the approve button; the route check is the backstop.

Routes call `requireRecentAuth(db, accountId)` right after `readSession()`;
pages call `hasRecentAuth(db)`. The client components behind those buttons
(`src/lib/reauth-client.ts`) react to the 403 by navigating to
`/login/reauth?return_to=<current page>`, which asks for whichever proof the
account has — the password, an authenticator or recovery code, or a passkey —
and returns. The proof routes (`POST /api/auth/reauth` with `{password}` or
`{code}`, `POST /api/auth/reauth/passkey/{options,verify}`) stamp the current
session row in place: the token and cookie never change, so in-flight
requests and the frame hub's browser sockets are unaffected. An account with
nothing local to check (Google sign-in, no password, no second factor) is
sent back through Google with `prompt=login`
(`/api/auth/google/start?reauth=1`); the callback mints a fresh session, which
counts as recent. Checks are rate-limited per IP (30 / 15 min) and per
account (10 / 15 min); every attempt is audited
(`account.reauthenticated` with `method: password|totp|recovery_code|passkey`,
`account.reauthentication_failed`).

Deliberately **not** gated: scene assignment (`POST /api/frames/{id}/scenes`)
and settings pushes — those are the workspace's save path, and a prompt on
every save would train users to click through it. Revoke and grant are the
actions that change *who* controls a frame; the rest changes *what* it shows
and is undone by the next save.

## Google OAuth Client

Create an OAuth 2.0 Client ID (type "Web application") in the Google Cloud
Console and register the redirect URI for each environment:

```text
{FRAMEOS_CLOUD_APP_URL}/api/auth/google/callback
```

Then set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. When unset, the login
page hides the Google button and password sign-in keeps working.

## Superadmins and the Admin Panel

`accounts.is_superadmin` gates `/admin` and `/api/admin/*`. The flag is checked
against the database on every request, so revoking it takes effect
immediately. Only a session cookie counts: a personal API token minted by a
superadmin is refused on every `/api/admin/*` route (`getSuperadminContext`
returns `forbidden` for tokens), and the one automated admin caller — the
nightly accounting job — runs on a job token (`cloud/docs/mcp.md`, "Job
tokens") on an account that is not a superadmin. The panel lists accounts
(search by email or name) and supports:

- Granting and revoking the superadmin flag (never on your own account).
- Signing a user out everywhere (revokes all their sessions).
- Deleting an account, which cascades to identities, sessions, and backend
  links. Deletion is audited with the email recorded in the event payload.

Bootstrap the first superadmin after that user has signed in once:

```sh
pnpm admin:grant you@example.com
pnpm admin:grant --revoke you@example.com   # to remove the flag
```

## Migrating Accounts From Logto

Accounts created under the previous Logto integration still exist with a
`logto` identity row but have no password and no Google identity. Such users
should use "Forgot password?" to set a password (which requires their
`account_identities.provider_subject`-independent email to resolve — i.e. a
password identity). If Logto-era accounts must be preserved, insert password
identities for them manually:

```sql
INSERT INTO account_identities
  (account_id, email_snapshot, email_verified, provider_issuer, provider_key, provider_subject)
SELECT account_id, lower(email_snapshot), email_verified, 'frameos-cloud', 'password', lower(email_snapshot)
FROM account_identities
WHERE provider_key = 'logto' AND email_snapshot IS NOT NULL
ON CONFLICT DO NOTHING;
```

After that, a password reset on the matching email attaches a usable password.
Google sign-ins with the same verified email also link automatically.
