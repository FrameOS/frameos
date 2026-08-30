# FrameOS — a deep, brutal analysis, re-run

*Written 2026-08-30 against `main` at `60e41e83` plus branch
`convergence-stage-4`. Replaces the 2026-08-29 analysis (in git history:
`git show 60e41e83:docs/convergence-brutal-analysis.md`), which was written
before any of the convergence work landed. Same question: "the goal is a
canvas onto which software can be loaded, running on an ESP32 and a Pi,
showing images on e-ink or HDMI. Is this the best way to do that?" Same
method: numbers first, then the verdict, then what to do. The point of
re-running it is to say honestly what 36 hours of work changed and what it
did not.*

## What this project is now (numbers)

Tracked source, excluding assets, `repo/` and the vendored Waveshare C:

| Plane | Size | Δ vs 2026-08-29 |
|---|---|---|
| `frameos/` runtime (Pi + ESP32 core) | ~100k Nim | +10k (counted with the `.c`/`.h` shims this time) |
| `embedded/esp32/` | ~32k C | ≈ |
| `backend/` control plane | ~85k Python | ≈ |
| `frontend/` | ~96k TS | ≈ |
| `cloud/` | ~121k TS | ≈ (measured without `e2e`) |
| `e2e/` | ~12k TS | ≈ |

Still roughly half a million lines, five languages, one committer; **339
commits in August 2026** (1,534 in the repo's whole history — a fifth of
the project happened this month). 521 test files.

The part this program is about, measured on the branch:

| The legacy source-build path (all still present) | LOC |
|---|---|
| `backend/app/codegen/` (scene + driver + config Nim generation) | 5,250 |
| `utils/cross_compile.py` + `build_executor.py` + `build_host.py` + `modal_sandbox.py` + `prebuilt_deps.py` | 3,122 |
| `binary_builder.py` (half of it is the source branch) | 473 |
| frontend `SceneSource/` panel | 209 |
| `frameos-cross.yml` — two per-frame build jobs | 1 workflow |

| What was added to get rid of it | LOC |
|---|---|
| `cloud/packages/scene-convert` (grammar, model pass, lint loop, CLI) | 3,506 |
| converter route + page + editor hook-up + MCP tool | ~1,200 |
| Stage 1–2 warnings, chips, confirms, `sceneRequiresCompilation` twins | ~600 |
| Stage 4 plan fields, installer copy, docs | ~100 |

So: **about 9k lines are now deprecated, documented on one page and off the
PR path, and about 5.4k lines were written to make deleting them safe.**
Net, the repo is larger than it was two days ago. That is the correct shape
for a deprecation — but only if Stage 5 actually happens. A deprecation
that never reaches its deletion is just a feature with worse UX.

## What changed in 36 hours

- **No new Nim is produced.** Every editor path that used to seed or flip
  to Nim now seeds JavaScript or asks first (Stage 1).
- **Every surface warns.** Frame list, dashboard, deploy drawer, scene
  sidebar, editor header, scene settings, the wasm preview, the cloud's
  publish/assign (Stage 2).
- **A converter exists and works** on the one real-world compiled scene we
  have: zero model calls for its five Nim code nodes, one for its Nim app,
  lint-clean, renders headless. Public route, page, CLI, MCP tool, and a
  button in the editor (Stage 3, no-frills).
- **The default is the binary, and the legacy path is fenced, not cut.**
  A fresh frame never compiles; a compiled scene or an explicit `static`
  mode still gets the old source build, on purpose — a path that exists
  should work when asked for. `build_kind` records which frames still take
  it; CI no longer compiles a frame per pull request; one page documents
  the path (Stage 4). An earlier cut of Stage 4 gated the build behind a
  per-frame switch and made an explicit `static` inert; it was pulled the
  same evening as silly — disabling code that is still shipped is the worst
  of both.

That is the whole of the plan short of deletion. What follows is what is
*still* true.

## The honest verdict, re-run

### 1. Three-and-a-half ways to execute a scene → still three-and-a-half

Nothing was deleted. Compiled scenes are hidden, discouraged, warned about
and convertible — and every line that runs them is in the tree, tested,
and shipped in every release. The multiplication factor the first analysis
named is unchanged: the pulled Stage 4 cut had to change the plan logic in
`binary_builder.py`, mirror it in `frameDeployUtils.ts`, repeat it in the
Buildroot twin in `frame_deploy_workflow.py`, and touch the SD-image
eligibility check — four places for one rule, which is exactly the tax,
and exactly why a holding pattern should change as little as possible.
Meanwhile the JS side grew a 3.5k-line converter that is, for now, a fifth
way to *produce* a scene. The right reading: the program is half done, and
the second half — Stage 5 — is where all the payoff is. The date is set
(one release after 2026-08-30 plus a clean cycle); hold to it.

### 2. Four control planes → four, on purpose, and the bill arrived on time

Parked by decision, and the decision stands. But note the tax: the backend
and the frontend each carry `frame_compilation_mode` /
`frameCompilationMode`, `precompiled_skip_reason` / `precompiledSkipReason`,
`scene_requires_compilation` / `sceneRequiresCompilation`, and the cloud
carries a third `compiledSceneNames`. They agree today because one person
wrote them the same afternoon. There is no test that pins the Python and
the TypeScript to each other, the way `docs/cloud-frames-contract.json`
pins the verb tables. When the cloud absorbs frame management (parked,
"later"), all of these collapse into one; until then each is a place to
drift.

### 3. Rendering strategy → undecided, unchanged

Not touched by this program and not owed by it. Still the largest open
architectural question in the repo.

### 4. Nim is the moat and the cage → the cage got a door, the moat is intact

The converter reduces the Nim *users* write to zero. It reduces the Nim
*we* maintain by zero: the forked pixie, the transpiler (2.2k), burrito
(1.7k), `app_runtime.nim` (1.7k), the interpreter (1.8k) and the built-in
catalog are exactly where they were. That is the intended scope — "no
rewrite" — and it is right for now. But the first analysis's warning
stands: do not grow the Nim surface in parallel with the JS one. Stages
1–4 are Python and TypeScript; the runtime did not change at all. Good.

### 5. The cloud is a SaaS company → and it just grew a public, unauthenticated compute endpoint

`POST /api/scenes/convert` is public by design (self-hosters have no cloud
account), rate-limited per address, and spends the platform's OpenAI key
under an hourly/daily budget. That is a reasonable trade and it is also a
new abuse surface with a dollar sign on it, plus the 72nd MCP tool, plus a
page. Every one of those is right for the converter's job and every one of
them is more cloud to run alone. The first analysis's point — say whether
the goal is the canvas or the company — is still unanswered, and the answer
now matters for whether this endpoint stays public after the deprecation
window closes. Suggest: it does not; after Stage 5 the converter is a CLI
and a signed-in feature.

### 6. Velocity is outrunning verification → yes, and this branch is an example

Stages 1–4 ship with unit tests and passing type checks, and with exactly
one real-world compiled scene ever run through the converter. No converted
scene has been deployed to a panel from this repo's CI; the deploy e2e
still tests the legacy path (good — it is the path most likely to rot
unnoticed) and nothing tests the converted output on hardware. The list
from 2026-08-29 (dual console, sleep
forecast, E1004 OTA hold, 13.3e SPI, panel link code, …) has not shrunk.
The hardware-in-the-loop bench is still the most valuable thing nobody has
built.

### 7. New: the judgement metric is honest and blind

The plan says Stage 5 waits for "zero source builds for a release cycle".
`build_kind` now records that faithfully — **on each self-hosted backend's
own database**, which nobody but its owner can read. There is no
`deploy_finished` event (there never was; the plan assumed one) and the
backend only phones PostHog under two explicit opt-ins that have nothing
to do with deploys, so adding one would have been a new consent question
smuggled into a cleanup. The metric therefore cannot be observed
centrally. What *can* be observed: the cloud's `scene_convert` PostHog
event (conversions attempted, model calls, failures), converter page
visits, and GitHub issues. Decide now that those are the proxy, or accept
that the deletion date is a calendar date, not a measured one.

### 8. New: the holding pattern has no forcing function

Because nothing changed for the frames that still compile, nothing pushes
their owners to convert except the amber chips and the release notes. That
is deliberate — a self-hoster upgrading in six months must not find a
blank panel — but it means the deletion date will arrive with some frames
still on the path, and Stage 5's "data first" step (stamp them
`interpreted`, leave `needsConversion` notes) is what those frames will
actually experience. Say so in the release notes now, twice, so the
deletion is not the first they hear of it.

## What is genuinely right (keep)

Everything the first analysis listed still holds, plus:

- **Pulling the switch.** The first Stage 4 cut was clever and wrong:
  hidden code that refuses to run is a bug report waiting to happen, not a
  deprecation. The fence is the warnings, the converter and the date;
  the machinery stays working until the day it is deleted.
- **Conversion drops the Nim** rather than keeping it as a sibling. The
  editor could not tell the two apart, and nobody needs the old code — the
  original file is the backup. Additive-and-reversible sounded safer and
  would have been a permanent ambiguity.
- **The plan was followed, and corrected where it was wrong** (the
  telemetry item, the HA docs living in another repo, the e2e that tests
  the legacy path staying on PRs). The doc says so instead of quietly
  ticking boxes.

## What "best" looks like from here

Shorter than last time, because most of it is now "wait, then delete":

1. **Sit on it.** No further convergence work until one release has
   shipped with Stage 4 in it. Use the time on the hardware bench, not on
   Stage 3's optional leftovers.
2. **Write the release-notes entry now** ("compiled scenes are deprecated,
   here is the converter, here is the date"), and repeat it in every
   release until Stage 5. §8 is the surprise that will otherwise come.
3. **Pin the twins.** One fixture file of scenes with expected
   `requiresCompilation` / `execution` / skip-reason outcomes, run by the Python
   tests, the frontend tests and the cloud tests — the
   `cloud-frames-fixtures.json` pattern, applied to this rule. Cheap, and
   it makes §2's drift a test failure instead of a bug report.
4. **When the date comes, delete in the order Stage 5 lists**, data first,
   and delete the converter's public exposure with it (§5).
5. **Then** reopen the parked questions — hub-rendered bitmaps for weak
   boards, one control plane — with 9k fewer lines in the way.

## Bottom line

Two days ago the repo contained its best design buried under three older
ones. Today the oldest of the three is labelled on every surface, has an
exit ramp, a date, and a page of its own; nothing has been removed and
nothing has been disabled. That is progress of the only kind
this codebase can afford — reversible, small, tested — and it is worth
nothing until the fence is replaced by an empty lot. The date is written
down. Keep it.
