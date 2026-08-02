# Cloud Link & Login — Security Review (2026-08)

Review of the merged cloud work (device-flow linking, cloud login handoff)
across this repo and the FrameOS Cloud service. The first pass fixed the
handoff and lock/IO findings; the second closed the device, backend and
cloud-service items below. What remains open is listed last, with why.

## Fixed in the first pass

- **Login handoff was not bound to the browser** (HIGH). The `state` token
  lived only server-side (Redis on the backend, `login_states` on the frame),
  so it proved a handoff was in flight, not who began it. Anyone able to call
  the open `/api/cloud/login/start` could hand the resulting callback URL to a
  victim (logging them into the attacker's account), and a leaked code could be
  replayed from the attacker's browser to take over the owner's session. Now
  also a `HttpOnly`/`SameSite=Lax`/path-scoped cookie, required to match at the
  callback, checked before the state is consumed.
- **Frame skipped its owner check when the owner was unknown** (`account_id`
  absent because the grants call failed during connect) and minted an admin
  session on the provider's word. Now refuses and re-syncs.
- **`/api/cloud/poll` held the global cloud lock across two outbound cloud
  requests** — a slow provider froze every cloud route for 70 s+. Sync moved
  outside the lock.
- **`login_states` grew unboundedly** from the open `/login/start`, so every
  later cloud request re-parsed and rewrote a growing file under that lock
  (O(n²)). Capped at 16.
- **The open `/login/callback` rewrote the state file on every bogus request**
  (SD-card wear + lock contention). Now writes only when pruning changed
  something.
- **Passwordless lockout**: cloud-created users have no local password and the
  change-password route demanded the current one, so a later broken link locked
  them out permanently. Setting a first password no longer requires it;
  `check_password` no longer raises on a NULL hash.
- **Cloud: silent scope escalation** — `backup:*` and `store:publish` were
  auto-granted without consent; `backup:*` reads *all* account backups.
  Auto-grant set is now empty.
- **Cloud: stored copy of live link tokens** — `encrypted_refresh_token` was
  never cleared after the single-use poll, so a DB dump plus the key yielded
  every active token. Nulled on redemption and rotation.

## Fixed in the second pass — device (Nim)

1. **DNS was unbounded** (HIGH). `connect()` runs `getAddrInfo` before arming
   its timeout, and `boundedRequest` re-resolved on every redirect hop, so with
   a blackholed resolver one unauthenticated `/api/cloud/login/start` per
   worker thread (there are 1–4) wedged the HTTP server for minutes,
   repeatably. Requests now resolve once up front through a short TTL cache
   that also remembers failures, so a dead resolver costs one stalled request
   per window instead of one per request. Cloud calls additionally cap
   redirects at 1 and their whole-request budget at 20 s.
2. **No rate limiting anywhere** in `frameos/src`. Added per-client-address
   fixed windows (`server/rate_limit.nim`) on the three open cloud login routes
   — `/login/start` most tightly, since one anonymous LAN call there becomes an
   authenticated call to the provider — and on `/api/admin/login`, which had no
   lockout, delay or attempt counter in front of the only password on the
   device. Credential comparison is constant-time now too.
3. **50 MB request bodies were buffered before any auth check.** mummy reads
   the whole body before dispatching and has no connection cap, so a few
   concurrent unauthenticated uploads pushed a 512 MB frame past
   `MemoryMax=90%` into the `Restart=always` loop. The cap is 8 MB — the
   frontend uploads assets in 512 KB chunks, so nothing legitimate comes close.
4. **`frame.json` was re-read and re-parsed up to 3× per auth check**, before
   the 401. Memoized on mtime+size, so settings edits still take effect without
   a restart.
5. **`/api/cloud/login/options` disclosed the provider URL** to anonymous
   callers. It now returns the URL only when cloud login is actually available
   (when the browser has to be sent there anyway), and is rate limited before
   it takes the lock.

## Fixed in the second pass — backend (Python)

6. **`/api/cloud/setup/*` was unauthenticated while no user exists** (MEDIUM).
   A LAN attacker could pre-link a fresh install to *their* cloud account with
   scopes of their choosing, and `setup/status` handed out the pending
   `user_code`. The original rationale — "anyone who can reach a fresh install
   can already claim it through the open `/api/signup`" — does not hold:
   claiming it through signup is visible to the owner, pre-linking it is not.
   The flow is now claimed by the browser that starts it (`setup_claim`, an
   `HttpOnly` cookie hashed into the link row); another browser sees that setup
   is in progress but not the code, and can only take over by first clearing
   the pending link.
7. **`local_origin` came from `Host`/`X-Forwarded-Host` with no trusted-proxy
   config**, ahead of `Host`, and governs the login `redirect_uri` allowlist,
   the logout `return_to` allowlist and the installs iframe target. It now
   comes from `FRAMEOS_PUBLIC_URL` when set, and honours forwarded headers only
   from a loopback or private-range peer (or one listed in
   `FRAMEOS_TRUSTED_PROXIES`).
8. **Local sessions were not revocable.** Both credentials — the Fernet cookie
   and the bearer JWT — carried `{sub, exp}` and nothing else, so nothing
   recorded that a session existed and nothing could end one: logout only asked
   the browser to drop its cookie, and revoking the link (or the cloud session
   behind it) left local access valid for up to 7 days. Each credential now
   carries a `jti` backed by a `user_session` row, mirroring the cloud's
   `sessions` table. Logout revokes; a password change revokes every *other*
   session; losing the cloud link revokes the sessions that exist because of
   it. Credentials minted before this have no `jti` and are refused, so every
   install signs in once more after upgrading.
9. **`http://` providers were accepted for any host.** Grants, identity claims
   and the link token all ride that connection, so on plain HTTP an on-path
   attacker can forge a revocation or the claims a login is minted from. https
   is now required except for loopback, RFC1918 and `.local` hosts.
10. **`_allowed_return_origin` accepted any loopback origin** from the caller's
    `Origin` header. It now requires the request to have come from this machine
    (which is the development case it exists for). Behind a same-host reverse
    proxy every peer is loopback, so there it is no stronger than before; the
    target is still restricted to loopback, which bounds it to a self-redirect.

## Fixed in the second pass — cloud service

11. **Device-flow phishing** (HIGH). `safeLocalOrigin` did not do what its name
    says — it accepted any public origin — and that value is shown to the
    approving user as where the request came from, is the sole allowlist for
    the login handoff's `redirect_uri`, and is where the approval screen
    navigates the browser afterwards. A request claiming
    `https://frameos.example.com` looked exactly as legitimate on the consent
    screen as a real one, and then received login codes. It is now restricted
    to addresses a self-hosted install can actually have. The consent screen
    labels the reported address as reported, and when the code arrived in the
    URL rather than being typed it requires an explicit confirmation before
    approval is possible — so following `verification_uri_complete` is no
    longer one click from connecting an attacker's client.
12. **The poll rate limit was below the protocol's own polling rate**: 120
    requests / 15 min / IP against exactly 120 polls per 10-minute flow at
    `interval: 5`. Two installs behind one NAT starved each other, and both
    clients treat a 429 there as fatal and tear the link down. Keyed on the
    device code now — a 40-byte secret the caller must already hold — so each
    flow is bounded independently.
13. **`auth:login` was checked only at `/start`.** The request token lives 10
    minutes and the login code 2, so removing the scope left a window where
    both still worked. Re-checked at `authorize` and at `token`.
14. **`frameos_login_codes.profile` (email, name, subject) had no retention.**
    Cleared as soon as the claims are released to the one client entitled to
    them, instead of waiting for a cleanup run up to a week later.
15. **User codes were unsalted SHA-256 with the first 4 characters stored in
    clear**, leaving ~2^20 candidates — trivially exhausted by anyone who can
    read the database, who could then approve a pending request before its
    owner does. Now HMAC-SHA256 under a key derived from `SESSION_SECRET`.

## Still open

- **The frame stores its link token in plaintext** in `state/cloud_link.json`
  (mode 0600), where the backend encrypts its copy. The file-handling
  weaknesses around it are fixed — the file is created 0600 rather than
  chmod'ed after the write, the state directory is 0700, and the replace is a
  plain rename so an interrupted write cannot lose the link — but the token
  itself is still readable. Encrypting it only helps if the key lives somewhere
  the file does not, and on a Pi with no secure element any key we could derive
  is on the same SD card; that is obfuscation, not encryption. Worth doing when
  there is hardware-backed key storage, or if the state file starts travelling
  (support bundles, asset backups) — in which case the fix is to redact it
  there, not to encrypt at rest.
- **Cloud rate limiting is in-memory per process.** It is the primary
  brute-force control on `device:authorize`. The cloud runs as one instance on
  one host today (see `cloud/docs/cloud-frames.md`), where this holds; a shared
  store is a prerequisite for a second instance and is already tracked in
  `cloud/TODO.md`. Deliberately not papered over here.
- **`device/request` has no per-account rate limit**, only per-IP, so a
  signed-in attacker can enumerate user codes at 60/15 min per IP. The keyed
  hash above removes the offline-guessing path; an identity limit here would
  close the online one.
- **First links may still request `auth:login`.** Refusing security-sensitive
  scopes on a first link was considered and rejected: frames link with
  `frame:link` + `auth:login` in one approval and have no feature manager to
  add it afterwards, so this would break direct frame linking outright.

## Answered questions

- **Does an offline server sever the link?** No. `linked_clients` has no
  expiry, `last_seen_at` is never read by any query, cleanup never touches
  links, and the backend never auto-disconnects or rotates. Only an explicit
  401 (genuinely revoked) resets it — and that deliberately re-enables local
  password login. The one real footgun — changing `SECRET_KEY` silently killed
  the link, since the stored token could no longer be decrypted while the UI
  still showed "connected" — is fixed: `CLOUD_SECRET_KEY` decouples cloud
  secrets from `SECRET_KEY`, `PREVIOUS_SECRET_KEYS` recovers an already-rotated
  install (secrets are re-encrypted on the next sync), and an undecryptable
  token is now reported loudly instead of silently ignored. See
  `docs/cloud-link.md`.
- **Can a passwordless user log in if the link is broken?** No, and there is no
  fall-open path: every failure mode (cloud down, 500, timeout, revoked,
  disabled) fails closed, and `not user.password` is checked before the hash
  comparison. The real risk was the opposite — permanent lockout — now fixed.
- **Can we hide local login on the frame when only cloud login is available?**
  The backend already does this (`local_login_enabled` from
  `/api/cloud/login/options`, enforced with a 403, and only disableable while a
  live grants check passes so you cannot lock yourself out). The frame
  hardcodes `local_login_enabled: true` and its UI ignores the field. Making it
  real needs the flag persisted in the frame's cloud-link state plus
  enforcement in the admin login — otherwise hiding the fields is cosmetic.
