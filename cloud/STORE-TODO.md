# FrameOS Store — plan and work tracker

An npm-style registry for FrameOS scenes (template zips), later apps. Users
publish scenes from their own FrameOS install, keep them private or make them
public, and browse/install public scenes from any FrameOS install or the web.

Two sides of this monorepo:

- **`cloud/`** — registry storage, publish API, public repository index, web
  store front, moderation tooling.
- **the rest** — "publish to cloud" from the templates UI, and the store
  surfaced through the existing repositories system. The public protocol
  lives in `docs/cloud-link.md` at the repo root.

## Decisions (made, with rationale — revisit criteria noted)

1. **Web-first identity, no usernames (WordPress model, not npm).** Publishers
   are cloud accounts; the store shows the account display name. Scene slugs
   are a single global namespace (like npm package names) but collisions are
   resolved by auto-suffixing rather than rejection, so there is no name
   squatting economy and no username reservation problem on day one.
   *Revisit when:* publisher profile pages or "verified publisher" trust
   signals are wanted — that needs stable public handles.
2. **Immutable versions (npm/crates.io model).** A publish always appends
   version N+1; bytes of a published version never change, so a compromised
   account cannot silently swap content under a version people already
   installed. The pragmatic deviation — keeping only the newest 20 versions,
   because they were Postgres blobs — was **retired on 2026-08-17** when the
   blobs moved to object storage (decision 6). Every published version stays
   downloadable, and identical bytes across versions are stored once.
3. **Private by default; public is an explicit act.** Publishing from the app
   creates a private scene; making it public is a deliberate toggle (in-app
   choice or on the web). Safer default for a registry that accepts content
   that can configure shell-running apps on devices.
4. **The distribution format is the existing template interchange zip, and the
   store index is the existing repository JSON format.** Old FrameOS installs
   can browse and install from the public store with no upgrade — the store is
   "just another repository" at `{provider}/api/store/repository.json`.
5. **Two kill switches, different severities (crates.io yank + admin pull).**
   *Yank* (per version, owner or admin): hides a bad version from new installs,
   keeps bytes auditable. *Pull* (per scene, superadmin only): scene disappears
   everywhere, downloads answer 410 Gone, republishing over it is blocked.
   Nothing is hard-deleted by moderation, so there is always an audit trail.
6. **Object storage for blobs, Postgres for everything about them.**
   Launched on Postgres `bytea` with hard caps (8 MB/zip, structural
   validation, per-account quotas), on the bet that the stored sha256 + sizes
   would make the move mechanical. They did: migration 0032 (2026-08-17) added
   an `object_key` beside each `content` and made `content` nullable, so the
   move needed no downtime — rows kept serving from whichever column they had
   until every one of them had been walked across.
   Production is Cloudflare R2 (bucket `frameos-cloud`, public alias
   `cloud-cdn.frameos.net`); development and CI get a directory under
   `db/object-storage`, so nobody needs credentials or a fake-S3 daemon to run
   the tests. Keys are content-addressed and namespaced by kind, so a preview
   republished a thousand times is one object and a fork copies a reference.
   Public store objects redirect to the CDN; private ones and every frame
   snapshot stay proxied through the app, where the session check applies.
7. **Pre-publish moderation via OpenAI omni-moderation.** Every
   publish — also private ones, illegal content must never be hosted —
   classifies name + description + preview image in one free API call before
   anything is stored; the same gate runs when a scene is made public or its
   description edited. Flagged categories (sexual, sexual/minors,
   violence/graphic, self-harm, harassment/hate in text) reject with 422 and
   an audit event. Configured via `OPENAI_API_KEY`; when the key is set but
   the API is unreachable, publishing **fails closed** (503). Without a key
   (dev/self-hosted) checks are skipped. Chosen over Google Vision SafeSearch
   because one call covers text + image, it is free, and needs only an API
   key. *Revisit when:* false-positive/negative rates demand a second opinion
   or category-score thresholds.
8. **Publisher pages use opaque account ids** (`/publishers/{uuid}`), shown
   by display name — the smallest step that gives "more from this publisher"
   without minting a username namespace. A page only exists while the account
   has ≥1 public scene, so ids cannot be probed. *Revisit when:* pretty
   handles are wanted; the URLs can then 301.
9. **Ratings/comments: not building them.** Download counts + featured shelf
   + reports cover curation at this scale; comments create a second
   moderation surface for marginal value. *Revisit when:* the catalog is big
   enough that download counts stop discriminating.

## Ideas borrowed from other package managers

| Source | Idea | Status |
|---|---|---|
| npm | Immutable versions; publish = append-only | adopted |
| npm | Provenance/attestation of what built the package | later (with apps) |
| crates.io | Yank: soft-hide, never rewrite history | adopted |
| PyPI | Quarantine state for suspect packages (admin pull ≈ quarantine) | adopted (as `pulled`) |
| PyPI | Trusted publishing / scoped tokens | already have: linked-client tokens with `store:publish` scope |
| WordPress.org | Web-first identity, no CLI usernames | adopted |
| WordPress.org | Human review before public listing | not adopted (post-moderation + kill switch instead); revisit if abuse appears |
| F-Droid | Server-side structural validation of every artifact | adopted (zip parsed, manifest + scenes required, bomb guards) |
| Docker Hub | Curated "featured/official" shelf distinct from "all" | adopted |
| Steam Workshop | One-click user reporting | adopted |
| App stores (Apple/Google) | Automated content scanning before listing | adopted (omni-moderation gate) |
| Homebrew | Analytics: install counts inform curation | adopted (download counts) |

## Threat model / abuse notes

- **Malicious scene content.** Scenes are data, but FrameOS apps they configure
  can run shell commands on frames. Mitigations: structural validation at
  publish (must be a real template zip), private-by-default, admin pull with
  410 on downloads, immutable versions (no byte-swapping under a trusted
  version), audit events for every publish/visibility change, rate limits and
  quotas, shell-command detection with store badges and confirm-before-install,
  user reporting, and account-level publish bans.
- **Zip bombs / resource abuse.** Compressed ≤ 8 MB, uncompressed ≤ 32 MB,
  ≤ 200 entries, preview image ≤ 4 MB, entries inflated only after size check;
  ≤ 200 scenes/account, ≤ 100 MB total stored bytes/account; publish rate
  limit per token; 30 publishes/hour and 20 *new* scenes/day per account;
  10 reports/day; per-IP limits on every store route.
- **Name confusion.** Global slug namespace with auto-suffix; display name is
  free-form but the publisher account is always shown. Typosquatting is low
  value while installs go through browsing (not by typing names) — revisit if
  a CLI-style `install by name` ever ships.
- **Moderation replay.** Publishing to a pulled scene is rejected; pulling is
  superadmin-only, audited, reversible.

## What exists

The registry core, the frameos integration, and the hardening/growth round
are all live: publish API with zip validation and quotas, the public store
front and repository.json, owner management and superadmin moderation,
"Private cloud scenes", risk badges, wasm live previews and the in-page
`frameos-editor`, and integration tests across the lot. Details in
`docs/cloud-link.md`; schema in `packages/db/src/schema.ts`; store logic in
`apps/auth-web/src/lib/store.ts`.

## Remaining work

Tracked in `docs/todo.md` at the repo root: apps in the store (pending a
signing/review story) and the open questions on pre-review, unpublish policy
and usernames. Object sweeping and the bucket backup shipped in 2026-08.

## Protocol summary (details in docs/cloud-link.md at the repo root)

```
POST {provider}/api/store/publish                  (Bearer, store:publish)
     { name, description?, visibility?, content_base64, content_type? }
     → { status, scene: { id, slug, name, visibility, version, url, risk_flags } }
     422 content_rejected {categories} · 503 moderation_unavailable ·
     403 store_banned · 429 daily_scene_limit_exceeded
GET  {provider}/api/store/repository.json          (public) frameos repository format
     entries carry extra fields old installs ignore: author, flags, frameosVersion
GET  {provider}/api/store/account/repository.json  (Bearer, store:publish)
     "Private cloud scenes": own scenes incl. private; absolute URLs + sceneId
GET  {provider}/api/store/scenes/{id}/download     (public; ?version=N; 410 if pulled;
     private scenes: owner session or owner link token)
GET  {provider}/api/store/scenes/{id}/image        (same visibility rules) preview image
GET  {provider}/api/store/scenes/{id}/scenes.json  (same visibility rules) extracted
     scenes JSON of the latest version, for in-browser live previews
GET  {provider}/scenes/{slug}                      scene page; carries a frameos:zip
     meta tag so pasting the page URL into the frameos Templates search installs it
     (owner link tokens may fetch private pages)
POST {provider}/api/store/scenes/{id}/report       (web session) flag for moderators
```

Open questions moved to `docs/todo.md` (review-before-public for risky
scenes, unpublish policy, usernames).
