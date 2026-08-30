# Legacy source builds

*Written 2026-08-30 (docs/convergence-todo.md, Stage 4). This page exists so
the per-frame build path is documented in exactly one place while it waits
for removal. Nothing here is the recommended way to run FrameOS.*

## What FrameOS does by default

FrameOS is distributed as released binaries: eleven Linux tarballs
(`frameos-<version>-<distro>-<arch>.tar.gz` on the GitHub release, one per
`backend/bin/cross list` target) and the ESP32 firmware. A deploy from the
backend downloads the tarball for the frame's distro and architecture,
copies the binary and the driver libraries the frame needs, and restarts
the service. Nothing is compiled — not on the server, not on the device.
The same is true of Buildroot SD images (the image carries the release
binary), the curl installer (`frame_bootstrap.py`), `scripts/frameos-setup.sh`
and every cloud-managed frame. A fresh frame of any kind never triggers a
Nim compile.

## What a source build is, and who still gets one

A *source build* is the old path: the backend renders the frame's
configuration and its compiled scenes into the Nim source tree
(`backend/app/codegen/`), then compiles one `frameos` binary for that one
frame — in a cross-toolchain container (`backend/bin/cross`;
Docker / build host / Modal, see "Advanced: legacy source builds" in
Settings) or on the device itself. Two things still lead there, both
explicit, both deprecated:

- A **legacy compiled scene** (`settings.execution = "compiled"` — a
  scene-local Nim app, a Nim code node or a `source` node) on a frame whose
  installation mode is the default `precompiled`. Such a scene cannot run in
  the interpreter, so the deploy plan skips the release ("N compiled scenes
  are configured") and builds a `static` binary with the scene linked in,
  exactly as it always has. No scene becomes compiled without a confirm in
  the editor (Stage 1), and every surface that shows one says what it costs
  (Stage 2).
- The installation mode **`static`** ("Build from source — single binary"),
  under *advanced: installation mode* in Frame Settings and the deploy
  drawer. Chosen by hand, honoured as chosen.

`last_successful_deploy.build_kind` on each frame records what its last full
deploy did: `precompiled`, `cross` (server-side source build) or
`on_device`. On a backend,

```sql
SELECT count(*) FROM frame WHERE last_successful_deploy->>'build_kind' <> 'precompiled';
```

is the number this deprecation is judged by.

## The way out

Convert the scene. `docs/nim-to-js-conversion.md` describes the converter:
one click in the editor on any legacy scene, scenes.frameos.net/nim-converter
for a pasted scene, the `scene_convert` MCP tool, or the CLI in
`cloud/packages/scene-convert` with your own OpenAI key. A converted scene is
interpreted, previews in the browser and runs on the release binary; with
no compiled scenes left the very next full deploy installs the release.

## Running a source build anyway

Everything still works:

- **Backend, server-side**: Settings → "Advanced: legacy source builds"
  picks the build environment (Docker on the backend host — needs
  `/var/run/docker.sock` mounted and `TMPDIR=/tmp/frameos-cross` shared, as
  in the README's second `docker run` example — a remote build host, or a
  Modal sandbox). `backend/bin/cross build --target <slug>` is the same
  thing from a shell; `make cross-<slug>` in `frameos/` wraps it.
- **On the device**: with the build environment set to `none`, a Raspberry
  Pi OS / Debian frame compiles itself on a full deploy (slow; needs `nim`,
  `libssl-dev` and QuickJS, which the deploy installs). Buildroot frames
  cannot — they need a build environment or no compiled scenes.
- **CI**: `.github/workflows/frameos-cross.yml` compiles the checked-in
  `frameos/frame.json` against every target on merges to `main` and on
  demand. It no longer runs on pull requests.

## The date

The source-build path — `codegen/`, `cross_compile.py`, the build host and
Modal executors, the `compilationMode` select, the Nim textarea in the
editor — is removed in Stage 5 of `docs/convergence-todo.md`, **no earlier
than one release after the converter shipped (2026-08-30)** and only once
`build_kind` shows no source builds for a full release cycle. Until then it
stays, hidden, warned about, and working.
