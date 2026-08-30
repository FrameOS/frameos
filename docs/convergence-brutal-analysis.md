# FrameOS — a deep, brutal analysis

*Written 2026-08-29 against `cloud-mcp` (main at `78346daf`). The question asked:
"the goal is to build a canvas onto which software can be loaded, which would
run on an ESP32 and a Pi, to show images on an e-ink display or HDMI/etc. Is
this the best way to do that?"*

## What this project actually is (numbers)

Tracked source, excluding assets and the 44k-line vendored Waveshare C:

| Plane | Size | Language |
|---|---|---|
| `frameos/` runtime (Pi + ESP32 core) | ~90k | Nim (+ forked pixie) |
| `embedded/esp32/` | ~30k | C (ESP-IDF), 0 Nim |
| `backend/` control plane | ~86k | Python/FastAPI |
| `frontend/` | ~100k | TS/React/kea |
| `cloud/` (auth-web + frame-hub) | ~136k | TS/Next.js |
| `e2e/` | ~23k | TS |

Roughly **half a million lines, five languages, one committer**, 319 commits
in August 2026 alone (the 40 `build-codex-*` / `build-fable-*` directories in
`embedded/esp32` say most of that is agent-assisted). The stated goal fits in
one sentence: *load software onto a canvas, show it on e-ink or HDMI, on an
ESP32 or a Pi.*

## The honest verdict

No, this is not the best way to reach that goal. It is the **accumulated** way.
Nothing in the repo is individually stupid — most decisions were reasonable
when made — but almost nothing has been deleted, so every generation of the
design is maintained simultaneously. The cost is not any one subsystem; it is
the multiplication factor.

### 1. Three-and-a-half ways to execute one scene

- Compiled Nim scenes via Python codegen (`backend/app/codegen`, ~5k lines) —
  already declared legacy.
- The node-graph interpreter (`frameos/src/frameos/interpreter.nim`, ~1.8k) —
  the default.
- JS apps: QuickJS plus a **homegrown TypeScript transpiler written in Nim**
  (`transpiler.nim` 2.2k + `burrito.nim` 1.7k + `app_runtime.nim` 1.7k +
  `tokens.nim` 1k ≈ 7k lines of compiler we own).
- A wasm build of the above for the browser preview — which has already
  diverged from what frames run (the `radialGradient` → "No image provided"
  incident: browser wasm = main, frame = last release).

Plus two app ecosystems: 41 Nim apps under `frameos/src/apps/` that need a
firmware release to add one, and JS apps that are actually loadable. If the
goal is loadable software, the Nim app catalog is the wrong primitive, and
every new feature (the path field type, select `{value,label}` options — the
memory notes literally list "the six lists any option shape must touch") lands
in all of them.

### 2. Four control planes for one device

`docs/api-triality.md` documents it in our own words: backend API, Pi local
admin, ESP32 local admin — and the cloud is a fourth with its own hub protocol
(166 verb strings in `cloud/apps/frame-hub`, 44 handled in
`frameos/src/frameos/cloud/hub_client.nim`, and a **second, independent**
implementation in `embedded/esp32/main/fos_cloud.c` at 3.3k lines vs
`hub_client.nim` at 2.2k). The ESP32 firmware is not "FrameOS on an MCU"; it is
a second FrameOS written in C with a Nim renderer bolted on. `fos_http.c`
(2.9k), `fos_scenes.c`, `fos_settings.c`, `fos_ota.c`, `fos_console.c` all have
Nim twins on the Pi side. Bugs like "activate sent store uuids the device never
had" and "cloud Power form reset because a key wasn't in the diff list" are the
direct tax of that duplication.

### 3. Rendering strategy is undecided, so both are built

There is a thin-client path (`backend/app/api/embedded_device.py` renders and
dithers on the backend and ships FOSB packed bitmaps; the Pico is a pure thin
client) **and** a fat-client path (pixie on Xtensa: RGB565 canvas reserved at
boot, strip fills to dodge 9 MB gradient masks, streaming socket decode,
degrade-to-blur ladders, ~80 KB internal RAM free with 24/12 KB cloud-link
floors). The fat path is genuinely impressive engineering — and it is a fight
between a desktop floating-point vector rasterizer and a chip that cannot
afford a TLS handshake and a JPEG at the same time. Every board (E1004, 13.3E6,
PhotoPainter, TRMNL) has re-opened that fight. Meanwhile the README promises
"60 frames per second", which the ESP32 will never do and the thin-client path
cannot do either. Pick the customer.

### 4. Nim is the moat and the cage

Nim is a defensible choice for "Python-feel, compiles to C, runs on a Pi *and*
an MCU". But the tax is in the project's own notes: a forked pixie with a
growing patch set (EXIF endianness, gradient OOM strip fills, cyclic
`Image.root` under ORC that **segfaulted the host from any driver .so**),
nimble segfaulting on the network, the compiler crashing on macOS,
`ws`/`mummy`/`linuxfb` deps with tiny maintainer pools. Bus factor is 1 and the
language guarantees it stays 1. The JS-apps direction is the right escape
hatch; the mistake would be to keep growing the Nim surface (interpreter,
transpiler) in parallel.

### 5. The cloud is a SaaS company, not a canvas

136k lines of Next.js: 2FA + WebAuthn, sudo-mode re-auth, API tokens, an MCP
host, a scene store with link previews, AI chat v2 with a detached agentic tool
loop, an activity feed, SSH key management, R2 object storage, pgBackRest PITR,
rate limiting behind Cloudflare. None of that advances "put loaded software on
a panel"; all of it is security surface and support load carried alone. That
is fine if the actual goal is a business — but then say so, because it changes
what "best" means.

### 6. Velocity is outrunning verification

The working notes say "hardware unverified" or "hardware verification pending"
for roughly ten shipped features (dual console, sleep forecast, E1004 OTA hold,
13.3e SPI fix, gradient strip fills, panel link code, …). There are 695 test
files, but the paths that matter — a real panel refreshing after a real OTA —
are tested by one person, by hand, sometimes. At 300+ commits a month that is
not sustainable; it is a queue of latent regressions.

## What is genuinely right (do not throw it out)

- The principles in `CLOUD-TODO.md`: outbound-only, scoped tokens,
  local-first, paid = explicit. Keep.
- Interpreted scenes as default (no per-scene compile). Right call.
- The scene graph as a portable data format, with the same code running in
  browser wasm and on device. Rare and valuable.
- Signed OTA on both halves; vendor-C-only panel drivers; process spawning
  through one timeout-wrapped module. Adult engineering.
- The pixie streaming/budgeted decode work. It is the "no image proxies on
  frames" rule honoured in hardware.

## What "best" would look like from here

Not a rewrite — a **deletion program** with a target shape:

1. **One loadable-software format: JS.** Freeze the Nim app catalog, port the
   41 apps to JS apps (the AI eval harness can do the grunt work), delete
   compiled scenes and `backend/app/codegen`. The graph stays as data/UI; the
   interpreter becomes a thin scheduler around JS nodes rather than a second
   execution engine.
2. **One renderer, placed per device by capability, one protocol.** Boards
   that can render locally do; boards that cannot get a FOSB bitmap from the
   hub. Stop making every 8 MB board earn local rendering with heroic memory
   work — the hub can render at full quality in milliseconds. Both halves
   already exist; make it a device flag, not two architectures.
3. **One control plane.** The Python backend is the odd one out: the cloud and
   the frame both implement frame management in their own language, and the
   backend does it a third time plus Buildroot image building. The
   "cloud-as-future-backend" direction is right — say it out loud: freeze
   `backend/` to bugfixes + image building, and make the self-hosted product
   be the cloud stack run locally.
4. **ESP32: shrink `fos_*.c` toward transport + panel + power**, and route
   verbs through one shared layer. The C→Nim study says a wholesale port costs
   60–130 KB of flash; fine — but 3.3k lines of a second hub client is the
   wrong 3.3k to keep.
5. **A hardware-in-the-loop bench** (one Pi, one E1004, one 7-colour
   Waveshare) that runs on every release tag. Until that exists, "shipped"
   does not mean "works".
6. **Scope the cloud honestly.** If the goal is the canvas, the store + hub +
   auth is enough; AI chat, API tokens, WebAuthn are features for a company
   with a second engineer.

## Bottom line

The repo already contains the best design for the stated goal — JS-loadable
scenes, hub-rendered bitmaps for weak boards, a cloud-shaped control plane,
wasm preview. It is buried under three earlier designs that were never
removed. The best next move is not building; it is choosing, and then deleting.

## Postscript — what was decided (2026-08-30)

The analysis stands as written. The treatment in `docs/convergence-todo.md`
takes a narrower cut than "What best would look like from here" above, on
purpose — one deletion at a time, no rewrite:

- **§1, three-and-a-half ways to execute a scene → taken, in part.**
  Compiled Nim scenes are sidelined now (no new operation produces one,
  every surface warns, an AI converter ports them) and the codegen +
  per-frame compile machinery is deleted after a deprecation date. Porting
  the 40 Nim built-ins to JS is *not* taken: they stay in the binary, the
  interpreter dispatches to them by keyword, and the converter's "no JS
  equivalent" column is the running list of what a port would need.
- **§2, four control planes → not taken now.** The backend (Python,
  self-hosted, with SSH/terminal/Remote) and the cloud stay two products.
  Whether SSH moves into the cloud or the backend retires is parked.
- **§3, rendering strategy → not decided.** Thin clients keep
  `/embedded/render`; the hub-renders question stays open.
- **§4, ESP32 verb duplication → settled by measurement** (PR #412 scrapped,
  PR #413's shared contract merged). A scene `.so` mechanism was also
  measured, in 2026-08-16's `shared`/`shared-scenes` modes, and deleted:
  Nim refs across a `.so` boundary under ORC crash the host.
- **§5 and §6, the cloud's scope and the hardware bench → unchanged and
  still owed.** Nothing in the current plan touches device code, so
  neither gates the other.
