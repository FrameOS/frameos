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
and every cloud-managed frame.

## What a source build is, and who still gets one

A *source build* is the old path: the backend renders the frame's
configuration and its compiled scenes into the Nim source tree
(`backend/app/codegen/`), then compiles one `frameos` binary for that one
frame — in a cross-toolchain container (`backend/bin/cross`,
`docker`/build host/Modal, see "Advanced: legacy source builds" in Settings)
or on the device itself. It exists for one reason: a **legacy compiled
scene** (`settings.execution = "compiled"` — a scene-local Nim app, a Nim
code node or a `source` node) cannot run in the interpreter and has to be
linked into the binary.

Since 2026-08-30 a compiled scene no longer triggers a source build by
itself. The deploy installs the release and lists the scenes that will not
run. A source build happens only when the frame's **legacy source build**
switch is on:

- `rpios.legacySourceBuild` / `buildroot.legacySourceBuild` = `true` in the
  frame's JSON; in the UI it is the first thing under "advanced:
  installation mode" in Frame Settings and in the deploy drawer.
- With it on, the installation mode below it applies (`precompiled` with
  the compiled-scene fallback, or `static`), exactly as before.
- The migration `d4e6f8a0b2c4` turned it on for every frame that had a
  compiled scene or an explicit `static` / `shared` / `shared-scenes` mode
  at upgrade time, so nothing changed for them. The amber "legacy
  compiled" chip says which frames those are.
- `last_successful_deploy.build_kind` on each frame records what its last
  full deploy did: `precompiled`, `cross` (server-side source build) or
  `on_device`. `SELECT count(*) FROM frame WHERE last_successful_deploy->>'build_kind' <> 'precompiled'`
  is the number this plan is judged by.

## The way out

Convert the scene. `docs/nim-to-js-conversion.md` describes the converter:
one click in the editor on any legacy scene, scenes.frameos.net/nim-converter
for a pasted scene, the `scene_convert` MCP tool, or the CLI in
`cloud/packages/scene-convert` with your own OpenAI key. A converted scene is
interpreted, previews in the browser, runs on the release binary, and the
switch above can go back off.

## Running a source build anyway

Everything still works while the switch is on:

- **Backend, server-side**: Settings → "Advanced: legacy source builds"
  picks the build environment (Docker on the backend host — needs
  `/var/run/docker.sock` mounted and `TMPDIR=/tmp/frameos-cross` shared, as
  in the README's second `docker run` example — a remote build host, or a
  Modal sandbox). `backend/bin/cross build --target <slug>` is the same
  thing from a shell; `make cross-<slug>` in `frameos/` wraps it.
- **On the device**: with the build environment set to `none` and the
  switch on, a Raspberry Pi OS / Debian frame compiles itself on a full
  deploy (slow; needs `nim`, `libssl-dev` and QuickJS, which the deploy
  installs). Buildroot frames cannot.
- **CI**: `.github/workflows/frameos-cross.yml` compiles the checked-in
  `frameos/frame.json` against every target on merges to `main` and on
  demand. It no longer runs on pull requests.

## The date

The source-build path — `codegen/`, `cross_compile.py`, the build host and
Modal executors, the `legacySourceBuild` switch, the `compilationMode`
select, the Nim textarea in the editor — is removed in Stage 5 of
`docs/convergence-todo.md`, **no earlier than one release after the
converter shipped (2026-08-30)** and only once `build_kind` shows no source
builds for a full release cycle outside frames with the switch on. Until
then the switch stays, off by default.
