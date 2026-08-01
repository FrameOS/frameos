# Cloud Link & Login — Security Review (2026-08)

Review of the merged cloud work (device-flow linking, cloud login handoff)
across this repo and the FrameOS Cloud service. Fixed items are marked; the
rest are open, ordered by severity, with the attack that motivates them.

## Fixed in this pass

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

## Open — device (Nim)

1. **DNS is unbounded by any timeout** (HIGH). `connect()` calls `getAddrInfo`
   before applying its timeout, and `boundedRequest` re-resolves per redirect
   (up to 6). With blackholed DNS, one unauthenticated `/api/cloud/login/start`
   per worker thread (1–4 requests) wedges the whole HTTP server for minutes,
   repeatably. Fix: resolve once per request, count DNS against the deadline,
   cap cloud redirects.
2. **No rate limiting anywhere** (`grep` finds none in `frameos/src`). The open
   `/login/start` also makes one authenticated cloud request per call —
   unlimited amplification toward the cloud from any LAN client.
3. **50 MB request bodies are buffered before any auth check**
   (`MAX_HTTP_BODY_LEN`), and mummy has no connection cap. ~10 slow uploads on
   a 512 MB frame → cgroup OOM under `MemoryMax=90%` → `Restart=always` crash
   loop. This is the one path that turns a DoS into a restart loop; lock
   contention alone does **not** starve the systemd watchdog (the runner thread
   heartbeats independently — verified).
4. **`frame.json` is re-read and re-parsed up to 3× per auth check**, before the
   401. Multiplies every flood; cache it.
5. `/api/cloud/login/options` is unauthenticated and takes the lock + reads the
   state file on every hit; it also discloses the configured provider URL.
6. The link token is stored **plaintext** in `state/cloud_link.json` (mode
   0600), where the backend encrypts its copy.

## Open — backend (Python)

7. **`/api/cloud/setup/*` is unauthenticated while no user exists** (MEDIUM). A
   LAN attacker can pre-link a fresh install to *their* cloud account with
   attacker-chosen scopes, and `setup/status` returns the pending `user_code`.
   The owner then completes signup and never notices. Fix: bind setup actions
   to a locally displayed one-time token, or force re-approval when the first
   user is created.
8. **`local_origin` comes from `Host`/`X-Forwarded-Host` with no trusted-proxy
   config**, and it governs the login `redirect_uri` allowlist, the logout
   `return_to` allowlist, and the installs iframe target.
9. **Local sessions are not revocable** — a self-contained Fernet cookie with no
   server-side record, 7-day lifetime versus the cloud's 8-hour session.
   Revoking the link (or the cloud session) leaves local access valid for up to
   7 days. Mirror the cloud's session table.
10. `http://` providers are accepted; over plain HTTP an on-path attacker can
    forge grants (forcing a link reset) or identity claims. Require https
    except for loopback.
11. `_allowed_return_origin` accepts any loopback origin from the caller's
    `Origin` header (self-redirect only, low impact).

## Open — cloud service

12. **Device-flow phishing** (HIGH). `/api/device/start` is unauthenticated with
    fully attacker-chosen `public_display_name`/`local_origin`, and
    `verification_uri_complete` auto-runs the lookup, so a victim is one click
    from approving an attacker's link. `safeLocalOrigin` does not require a
    private address despite the name. Fix: constrain `local_origin` to
    loopback/RFC1918/`.local`, label it unverified, stop auto-submitting, and
    add a confirmation step; consider refusing `auth:login`/`remote:access` on a
    first link.
13. **Poll rate limit is below the protocol's own polling rate** — 120 req /
    15 min / IP versus exactly 120 polls per 10-minute flow at `interval: 5`.
    Two installs behind one NAT starve each other, and both clients treat 429 as
    fatal and tear the link down. Key the limit on `device_code` and make 429
    retryable.
14. `frameos_login_codes.profile` (email, name, subject) has no retention job;
    null it on redemption and purge expired rows.
15. `auth:login` scope is checked at `/start` but not at `authorize`/`token`, so
    a 10-minute request JWT outlives a scope revocation.
16. User codes are unsalted SHA-256 with the first 4 chars stored in clear —
    trivially reversible by a DB reader. HMAC with a pepper.
17. Rate limiting is in-memory per-process; it is the primary brute-force
    control on `device:authorize`.

## Answered questions

- **Does an offline server sever the link?** No. `linked_clients` has no
  expiry, `last_seen_at` is never read by any query, cleanup never touches
  links, and the backend never auto-disconnects or rotates. Only an explicit
  401 (genuinely revoked) resets it — and that deliberately re-enables local
  password login. Caveat: changing `SECRET_KEY` silently kills the link (the
  token cannot be decrypted) while it still displays as connected.
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
