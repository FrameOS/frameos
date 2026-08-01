# FrameOS Store — plan and work tracker

An npm-style registry for FrameOS scenes (template zips), later apps. Users
publish scenes from their own FrameOS install, keep them private or make them
public, and browse/install public scenes from any FrameOS install or the web.

Two repos:

- **frameos-cloud** (`cloud/` in this monorepo) — registry storage, publish API, public
  repository index, web store front, moderation tooling.
- **frameos** (the rest of this monorepo) — "publish
  to cloud" from the templates UI, and the store surfaced through the existing
  repositories system. The public protocol lives in `docs/cloud-link.md` at the
  repo root.

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
   installed. Pragmatic deviation: only the newest 20 versions per scene are
   kept (these are Postgres blobs, not a CDN). *Revisit when:* moving blobs to
   object storage removes the reason to prune.
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
6. **Postgres bytea storage with hard caps** (8 MB/zip, structural validation,
   per-account quotas) rather than object storage. Right-sized for launch;
   the schema keeps sha256 + sizes so migrating blobs out later is mechanical.
7. **Pre-publish moderation via OpenAI omni-moderation** (Phase 3). Every
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
| npm | Immutable versions; publish = append-only | adopted (v1) |
| npm | Provenance/attestation of what built the package | later (apps phase) |
| crates.io | Yank: soft-hide, never rewrite history | adopted (v1) |
| PyPI | Quarantine state for suspect packages (admin pull ≈ quarantine) | adopted (v1, as `pulled`) |
| PyPI | Trusted publishing / scoped tokens | already have: linked-client tokens with `store:publish` scope |
| WordPress.org | Web-first identity, no CLI usernames | adopted (v1) |
| WordPress.org | Human review before public listing | not adopted (post-moderation + kill switch instead); revisit if abuse appears |
| F-Droid | Server-side structural validation of every artifact | adopted (v1: zip parsed, manifest + scenes required, bomb guards) |
| Docker Hub | Curated "featured/official" shelf distinct from "all" | adopted (v1) |
| Steam Workshop | One-click user reporting | adopted (Phase 3) |
| App stores (Apple/Google) | Automated content scanning before listing | adopted (Phase 3: omni-moderation gate) |
| Homebrew | Analytics: install counts inform curation | adopted (v1: download counts) |

## Threat model / abuse notes

- **Malicious scene content.** Scenes are data, but FrameOS apps they configure
  can run shell commands on frames. Mitigations now: structural validation at
  publish (must be a real template zip), private-by-default, admin pull with
  410 on downloads, immutable versions (no byte-swapping under a trusted
  version), audit events for every publish/visibility change, rate limits and
  quotas. Planned: scan scenes JSON for shell/exec app usage and badge those
  scenes on the store page and in the app before install ("this scene runs
  shell commands"), user reporting, account-level publish bans.
- **Zip bombs / resource abuse.** Compressed ≤ 8 MB, uncompressed ≤ 32 MB,
  ≤ 200 entries, preview image ≤ 4 MB, entries inflated only after size check;
  ≤ 200 scenes/account, ≤ 100 MB total stored bytes/account; publish rate
  limit per token.
- **Name confusion.** Global slug namespace with auto-suffix; display name is
  free-form but the publisher account is always shown. Typosquatting is low
  value while installs go through browsing (not by typing names) — revisit if
  a CLI-style `install by name` ever ships.
- **Moderation replay.** Publishing to a pulled scene is rejected; pulling is
  superadmin-only, audited, reversible.

## Phases

### Phase 1 — cloud registry core (done)

- [x] Schema: `store_scenes` (identity, visibility `private|public`, status
      `active|pulled`, `featured_at`, download count, preview image) +
      `store_scene_versions` (immutable payloads, yank), migration
      `0011_store_scenes.sql`.
- [x] Publish API for linked clients: `POST /api/store/publish`
      (`store:publish` scope): validates the template zip (fflate; manifest +
      scenes.json required, bomb guards), extracts the preview image,
      same-name republish by the same account appends a version, new names
      get a globally unique slug; quotas + rate limits; audit event.
- [x] Public store API (no auth): `GET /api/store/repository.json` (frameos
      repository format, public+active scenes, featured first),
      `GET /api/store/scenes/{id}/download` (`?version=N` optional; counts
      downloads; 410 when pulled; owner may fetch their private scenes with a
      web session), `GET /api/store/scenes/{id}/image` (preview).
- [x] Web store front: `/` lists featured and all public scenes (cards with
      preview, publisher, downloads); `/scenes/{slug}` detail page with
      description, version history, download, install instructions; pulled
      and private scenes render only for admins/owners.
- [x] Owner management: account page "My published scenes" (visibility
      toggle, delete), `PATCH/DELETE /api/account/scenes/{id}` (session +
      CSRF), version yank/unyank on the scene page for owners.
- [x] Moderation: `/admin/scenes` (superadmin) — list everything, pull with a
      reason / restore, feature/unfeature; `PATCH /api/admin/scenes/{id}`;
      audit events for every action; backups/activity visibility already on
      the account/admin pages.
- [x] Integration tests: publish → repository.json → download → count;
      scope enforcement; validation rejects junk; visibility + pull behavior;
      owner management routes; admin moderation routes.

### Phase 2 — frameos integration (done)

- [x] Backend: `POST /api/cloud/store/publish` (`store:publish` scope,
      login-gated) exports the template zip and publishes it; returns the
      cloud URL. Wrapper `store_publish` in `app/utils/cloud_link.py`.
- [x] Feature toggle: `store:publish` in `CLOUD_FEATURES` (Settings →
      FrameOS Cloud → Enabled features).
- [x] Templates UI: per-template dropdown action "Publish to FrameOS Cloud"
      (visible when linked with `store:publish`), success toast links to the
      scene page on the cloud.
- [x] Browse: the public store is auto-added once per project as a normal
      repository (`{provider}/api/store/repository.json`) when a cloud link
      exists — the existing repositories UI handles browsing/installing;
      deleting the repository row is respected (a settings flag remembers).
- [x] Protocol documented in `docs/cloud-link.md` (store section).

### Phase 3 — hardening and growth (done except apps/object storage)

- [x] Content moderation before publish (decision 7): images (CSAM, porn,
      gore) and text (vulgar abuse, hate) via `omni-moderation-latest`;
      fail-closed when configured; also gates make-public and description
      edits; audit event `store.publish_rejected`. Migration 0012.
- [x] Abuse limits on top of the Phase-1 quotas: 30 publishes/hour and 20
      *new* scenes/day per account (re-publishing an existing scene only hits
      the hourly cap), 10 reports/day, per-IP limits on every store route.
- [x] Shell-command detection: scenes JSON scanned at publish (shell-out app
      keywords like data/chromiumScreenshot + process APIs in code nodes),
      stored as `risk_flags` per version + denormalized on the scene, badge on
      the store card/page, `flags` field in repository.json, red "shell" tag
      and confirm-before-install in the frameos Templates panel. Heuristic,
      not a sandbox — code nodes are arbitrary Nim (threat model above).
- [x] User reporting: report button on public scene pages (signed-in, one
      open report per scene+reporter), superadmin queue at /admin/reports,
      resolve + jump-to-moderate; open-report badges on /admin/scenes.
- [x] Account-level publish ban (`accounts.store_banned_at`): publish answers
      403 store_banned; ban/unban per publisher from /admin/scenes; audited.
- [x] In-app private scenes: "My cloud drive" — authenticated
      `GET /api/store/account/repository.json` (link token, store:publish);
      the frameos backend proxies the listing + preview images and attaches
      the link token when installing zips from the provider host.
- [x] Search (name/description/publisher) + pagination on the store front.
      repository.json stays unpaginated (capped at 500) so old installs keep
      working; revisit past a few hundred public scenes.
- [x] Choose visibility at publish time: the publish API takes `visibility`
      from the app; in-app saving is deliberately private-first ("Save to
      cloud drive"), making public stays a web action (decision 3).
- [x] Publisher pages (decision 8): /publishers/{accountId}, linked from the
      scene page; `author` field in repository.json renders "by {name}" in
      the frameos Templates panel.
- [ ] Move blobs to object storage + CDN when size demands it; drop the
      20-version prune. (Deliberately deferred: ~100 MB/account caps make
      Postgres fine for launch; sha256 + size_bytes make the move mechanical.)
- [ ] Apps (not just scenes): needs a real code review story — signing,
      provenance, maybe human review before public listing. (Explicitly out
      of scope for now.)
- [x] Ratings/comments — decided against for now (decision 9).
- [x] Minimum FrameOS version per scene/version (`frameos_version`, migration
      0013): read from the zip's `template.json` (`frameosVersion`,
      conservatively stamped to the exporting FrameOS release; sanitized —
      short version-shaped tokens only). Owners can override it on the scene
      page, which publishes a new ZIP version so the manifest and listing stay
      aligned. Shown on scene cards/pages and as `frameosVersion` in both
      repository JSONs; frameos can show "newer than this install" as an
      upgrade nudge.
- [x] In-browser live preview on scene pages via the `frameos-wasm` npm
      package (built from frameos' `frameos/wasm`; version = FrameOS
      release). `GET /api/store/scenes/{id}/scenes.json` serves the extracted
      scenes with download access rules; the runtime assets are copied to
      /frameos-wasm by `apps/auth-web/scripts/copy-wasm-assets.mjs`
      (prebuild/predev). Scene HTTP requests run client-side first;
      CORS-blocked hosts fall back to `POST /api/store/preview-proxy`
      (anonymous but rate-limited, SSRF-guarded like frameos'
      scene_preview_proxy, 10 MB response cap). The dependency is the
      published npm package (`frameos-wasm@^2026.7.6`; version always equals
      the FrameOS release the runtime was built from).
      The preview shows the scene's FrameOS version on the button, has a
      resizable viewport, a restart button (full wasm reload), and asks for
      the credentials a scene's apps need (browser-only, never stored).
      Owners can publish edited scenes JSON as a new immutable version via
      `POST /api/account/scenes/{id}/content` (manifest/image carry over,
      risk flags recomputed, publish rate limits apply).
- [x] Visual scene editing on the web ("Edit scene" on owned scenes): the
      AGPL `frameos-editor` bundle (built from frameos' `frameos/editor` +
      `frontend/src/embed/`; app catalog and sources embedded, Monaco for JS
      app source viewing/editing) is served as-is from /frameos-editor
      (copied by `scripts/copy-editor-assets.mjs`, gitignored) and embedded
      in a full-screen iframe; the modal implements the documented postMessage
      protocol. (This began as an AGPL arms-length boundary; since the
      2026-07 monorepo merge the iframe stays because it is the editor's
      designed embedding and isolates its global styles and bundled
      runtime.) Saving posts the edited scenes to the content endpoint.
      The editor is the `frameos-editor` workspace package, built by turbo
      (frontend build → `frameos/editor/dist`) and copied into public/ by
      the prebuild step.
- [x] Tags (migration 0014): up to 5 publisher-assigned lowercase slugs per
      scene, edited on the scene page (moderated like descriptions), shown on
      cards/pages, filterable via `/?tag=x`, matched by search, and exposed
      as `tags` in both repository JSONs.
- [x] Categories (migration 0017): fixed taxonomy in `src/lib/categories.ts`,
      one category per scene driving the curated homepage shelves (replaces
      the old hard-coded service/gallery/pi-only tag shelves and the
      "Misc / demos" catch-all). Auto-assigned on publish by an LLM
      classifier (`store-classify.ts`, reuses OPENAI_API_KEY; fail-open —
      no key or an outage just leaves the scene uncategorized). Suggested
      tags are filled in only when the owner set none. Owners edit the
      category on the scene page; superadmins per-scene or in bulk
      ("Categorize missing" / "Redo all") from /admin/scenes. Filterable via
      `/?category=x`, exposed as `category` in repository.json.
- [x] /account split into subpages: overview cards plus installs, scenes,
      backups, and activity sections.

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
     "My cloud drive": own scenes incl. private; absolute URLs + sceneId
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

## Open questions

- Review-before-public for a category of risky scenes (contain shell apps)?
  Currently: automated moderation gate + shell badge + install confirmation +
  post-moderation (reports, pull, ban) — no human pre-review.
- Unpublish policy: owners can delete outright today (small registry, no
  dependents concept). npm learned the hard way — once anything can depend on
  a scene, switch to yank-only + support-mediated deletion.
- Usernames: still undecided long-term; the store works without them. The
  first feature that truly needs them is publisher pages.
