# Native lgpio Compatibility Layer

FrameOS no longer links against `liblgpio` or `librgpio`. The driver-facing
subset of `lgpio` used by Waveshare, Inky, GPIO buttons, and HyperPixel code is
implemented in `lgpio.nim`, with C-callable exports for the remaining
Waveshare C shims.

Attribution: this code was ported from Joan Aimer's `joan2937/lg` project,
pinned at upstream tag `v0.2.2` / commit
`b959a17d723360e85648316757b02dbea9902feb`.

Licenses: FrameOS is AGPL-3.0. The pinned upstream `joan2937/lg` source files
state the Unlicense/public-domain dedication, not LGPL. Keep that distinction
in comments and release notes when touching this module.
