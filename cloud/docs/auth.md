# First-Party Auth

FrameOS Cloud owns authentication end to end: email/password credentials,
optional Google and Apple sign-in, sessions, password resets, and the superadmin panel. There
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
  - Apple: issuer `https://appleid.apple.com`, key `apple`, subject = Apple's
    `sub` (one per team, so the web and the iOS app name a person alike).
    `provider_token_encrypted` keeps Apple's newest refresh token, sealed,
    for the revoke at account deletion (migration 0077).
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
- **Sign in with Apple** — the web's round trip and the iOS app's native
  sheet, both ending in a code exchange at Apple: "Sign in with Apple" below.
- **Signing in to the app** — see the next section.

## Signing in to the app

The FrameOS iOS app (`ios/`, `docs/ios-app.md`) signs in with email and
password through `/api/auth/login` like the web, and with Apple through its
own native route ("Sign in with Apple" below). For everything else the web
can do (Google, a passkey, a password with two-factor), it borrows the web's
sign-in through the system's sign-in sheet (`ASWebAuthenticationSession`) and
is handed a session of its own (`src/lib/app-sign-in.ts`):

1. The app opens `GET /api/auth/app/authorize?code_challenge=<S256>&state=…`
   (`&provider=google` to go straight to Google, `&reauth=1` to confirm it is
   you, below). The route wraps the request in a signed ten-minute token and,
   when the browser is not signed in, sends it through `/login` (or
   `/api/auth/google/start`) with a `return_to` back to itself.
2. Signed in, the route redirects to `frameos://sign-in?code=…&state=…`. The
   code is a two-minute HS256 token (its own derived key) naming the account
   and identity by id and carrying the browser session's `authenticated_at`;
   no email rides in the URL.
3. The app posts `{code, code_verifier}` to `POST /api/auth/app/token`. The
   verifier must hash to the challenge (PKCE S256), the code is spent once
   (`claimSingleUse`, the store the pending second-factor token uses), the
   profile is read fresh from the identity, and the answer sets a new session
   cookie, exactly what `/api/auth/login` sets. Every failure is
   `invalid_grant`. The sign-in is audited as `account.signed_in` with
   method `app_handoff`.

What keeps it safe:

- **The code only goes to `frameos://sign-in`**, and only the app that holds
  the verifier can spend it. A code read off a screen or a log is useless
  without the verifier.
- **A browser session from before the request is not handed on silently.**
  Another app could open the same URL in its own sign-in sheet; when the
  browser is already signed in, the route stops at `/login/app` ("Sign in to
  the app?", with "Use another account" and "Cancel") until the person
  presses Continue. Signing in, or re-proving, during the request is the
  consent itself. Continue is a `fetch` that then follows the redirect: a
  form post could not, the CSP's `form-action` refuses a `frameos:` target.
- **A handoff is never a fresh sign-in for sudo mode.** The app's session
  inherits the browser session's `authenticated_at` (`createSession`'s
  `authenticatedAt`), so an old browser session cannot become a recent one by
  passing through the app.
- **Confirming it is you in the app** (`reauth_required` on an account with no
  password and no second factor, a Google-only account, or one that confirms
  with a passkey) runs the same flow with `reauth=1`: a browser session older
  than `recentAuthMaxAgeSeconds` is sent through `/login/reauth` first, and the
  new app session carries that fresh proof. The app replaces its session with
  it and signs the old one out.

## Account Merging

One account can carry both sign-in methods; merges are gated on proof of
email ownership to block pre-hijacking:

Google and Apple follow the same rules (`src/lib/provider-account.ts`, and
`src/lib/provider-callback.ts` for both web callbacks); Google is the example.

- **Password first, then Google** — if the password account's email is
  verified and Google attests the same email, the callback does _not_ link
  on Google's word alone: the verified claims are parked in a signed,
  ten-minute `frameos_link_pending` cookie and the visitor is sent to
  `/login/link`, which asks for the account's password.
  `POST /api/auth/link` checks it, links the identity, revokes every
  existing session (a fresh one is minted), emails the owner
  (`google_linked` / `apple_linked`) and writes `account.google_linked` to
  the audit log; a wrong password is `403 invalid_password` and
  `account.google_link_failed`. The iOS app does the same after a native
  Apple sign-in: the route answers `409 link_required` with the cookie, and
  the app posts the password to `/api/auth/link` itself.
  From then on both methods sign into the same account. If the password
  account is _unverified_, the Google user is shown a warning and sent
  through the password reset flow first: the emailed link proves the address
  is theirs and evicts any password a squatter may have set. After the reset,
  the same password confirmation connects Google.
- **Google first, then password** — signup with that email is refused
  (`email_taken_google`) so a stranger can never plant a password on the
  account; instead, "Forgot password?" works for Google-first accounts and
  completing it creates a verified password identity on the same account.
- **Google first, then Apple (or the reverse)** — a new identity whose
  verified email already signs in through the other provider makes no second
  account: the visitor is told to use that provider (`use_google`,
  `use_apple`), and signup answers `email_taken_apple` as it answers
  `email_taken_google`. Connecting the second provider to the same account
  is a follow-up (a "connect" button under account settings).
- An Apple "Hide My Email" address is a private relay
  (`…@privaterelay.appleid.com`) and matches no existing account, so it
  always starts a new one.
- Identities with a provider-unverified email never participate in merging,
  and a new identity without an email gets no account (`*_email_missing`).

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
is opt-in, managed on the frames workspace's Security page
(`/account/security`), and ON exactly when the account has
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
regenerating recovery codes, turning 2FA off) runs behind sudo mode (below)
AND re-asks for the password when the account has one, otherwise for a
current authenticator/recovery code (`requireWeakeningProof`,
`src/lib/account-security.ts`). Because sudo mode on a two-factor account is
the second factor, turning 2FA off costs the very factor being removed plus
the password — the password alone never does it.

**Enrolling a factor revokes every personal API token** (`api_tokens_revoked`
in the confirm/attestation response): a token minted before the factor
existed would keep bypassing it. The settings page says how many were
revoked and the enrolment mail carries the same line; the owner re-mints
under Account → Developer, which is behind 2FA from then on.

**Google accounts and unverified addresses.** A Google identity we have not
seen whose `email_verified` claim is not `true` gets no account and no
session (`google_email_unverified`): such an account could never add a
password (every lookup ignores unverified identities) while a stranger could
still register a password account on the same address. An identity linked
earlier keeps signing in; its account was verified when the link was made. Every change is an
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
older than the route's window (`src/lib/recent-auth.ts`).

**Which proof re-authenticates** (`reauthMethods`): with two-factor OFF, the
password (or, for a Google-only account, signing in with Google again). With
two-factor ON — a confirmed authenticator or a passkey — the second factor
only: an authenticator/recovery code or a passkey. The password is then not
offered and not accepted (`POST /api/auth/reauth` answers
`403 second_factor_required`), so the one credential a phishing page or a
reused password hands an attacker cannot by itself revoke frames, approve
device links, mint API tokens or turn two-factor off. This is the same
standard sign-in holds the account to: sudo mode is "prove it again", not
"prove less". Two windows, matched to what the action can do:

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
  The same window guards `GET /api/settings?reveal=1` — every stored
  third-party key in one response, which the in-browser scene preview needs
  all through an editing session (fifteen minutes would mean re-proving
  while building a scene). The masked `GET /api/settings` is not gated; the
  preview surfaces degrade to "no saved keys" with a link to `/login/reauth`
  rather than failing.

Routes call `requireRecentAuth(db, accountId)` right after `readSession()`;
pages call `hasRecentAuth(db)`. The client components behind those buttons
(`src/lib/reauth-client.ts`) react to the 403 by navigating to
`/login/reauth?return_to=<current page>`, which asks for whichever proof the
account has — the password, an authenticator or recovery code, or a passkey —
and returns. The proof routes (`POST /api/auth/reauth` with `{password}` or
`{code}`, `POST /api/auth/reauth/passkey/{options,verify}`) stamp the current
session row in place: the token and cookie never change, so in-flight
requests and the frame hub's browser sockets are unaffected. An account with
nothing local to check (Google or Apple sign-in, no password, no second
factor) is sent back through its provider (`methods.providers` says which):
Google with `prompt=login` (`/api/auth/google/start?reauth=1`), Apple as is
(its web sign-in asks for the Apple ID's password or Face ID / Touch ID every
time). The callback mints a fresh session, which counts as recent. Checks are rate-limited per IP (30 / 15 min) and per
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

## Sign in with Apple

The App Store requires it of an app that offers Google (guideline 4.8), so
the iOS app has it natively and the web has it beside Google
(`src/lib/apple-sign-in.ts`).

- **Web**: `GET /api/auth/apple/start` sends the browser to Apple with
  `response_mode=form_post` (Apple's only way to hand over the person's name),
  and Apple posts back to `POST /api/auth/apple/callback`. That POST is
  cross-site, so it carries no `SameSite=Lax` cookie: the state, the nonce and
  `return_to` ride their own signed `frameos_apple_flow` cookie, `SameSite=None`
  and `Secure` in production, scoped to `/api/auth/apple`. The form's state
  must match it (the route's CSRF check: Apple's Origin is never ours). The
  code is exchanged with the Services ID, the id_token verified (Apple's keys,
  issuer, the Services ID as audience, the nonce), the name read from the
  `user` field, and the rest is Google's callback (`provider-callback.ts`),
  with 303 redirects so the browser does not post again.
- **The iOS app**: the system sheet hands over an identity token and an
  authorization code; the app posts them with its nonce to
  `POST /api/auth/apple/native`. The token must verify with the bundle id as
  audience and SHA-256(nonce) as its nonce, and the code is exchanged at Apple
  (which spends it, so a token and code taken off a device cannot be played
  again); the exchange's id_token must name the same person. Answers: a
  session (`{ok, email}`), `second_factor_required` (the app asks for the code
  as after a password), `409 link_required` (above), `409 use_google`,
  `verify_before_link`, `apple_email_missing`, `invalid_grant`,
  `503 apple_unavailable`. The app could also go through the web handoff
  (`/api/auth/app/authorize?provider=apple`), which works, but App Review
  expects the native button.
- **The client secret** is a five-minute ES256 JWT signed with the team's
  Sign in with Apple key, naming the client (Services ID or bundle id).
- **Account deletion** (`/api/account/delete`, the admin delete) revokes
  every Apple refresh token the account holds at `/auth/revoke`, with the
  client it was issued to, before the rows go (Apple requires it). A failed
  revoke is logged and never keeps the account.
- Not done yet: Apple's server-to-server notifications (consent revoked, Apple
  ID deleted, relay email turned off).

Setup, in the Apple Developer account (Certificates, Identifiers &
Profiles):

1. The App ID `net.frameos.app`: tick **Sign in with Apple** (as primary App
   ID).
2. **Identifiers → Services IDs**: a new one (e.g. `net.frameos.cloud`), Sign
   in with Apple on, grouped with `net.frameos.app`, domain
   `cloud.frameos.net`, return URL
   `{FRAMEOS_CLOUD_APP_URL}/api/auth/apple/callback`.
3. **Keys**: a new key with Sign in with Apple (primary App ID
   `net.frameos.app`). Download the `.p8` once.
4. **Sign in with Apple for Email Communication**: register the domain and
   address the cloud's mail comes from (Postmark's `POSTMARK_FROM_EMAIL`),
   with SPF/DKIM passing. Without it, mail to a private relay address
   (verification is not needed, but password resets and security notices
   are) is dropped by Apple.

Then set `APPLE_TEAM_ID`, `APPLE_SIGN_IN_KEY_ID`, `APPLE_SIGN_IN_PRIVATE_KEY`
(the `.p8`'s PEM; `\n` for newlines is fine) and `APPLE_SERVICES_ID`;
`APPLE_APP_BUNDLE_ID` defaults to `net.frameos.app`. With the key but no
Services ID only the app signs in with Apple; with neither the web hides the
button and the app's route answers `apple_unavailable`. `APPLE_AUTH_URL`
points everything at a stand-in (the integration tests' `src/test/apple-fake.ts`).

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
