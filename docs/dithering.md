# Dithering on the plane (`dither`)

When the control plane packs a picture for a palette panel (a thin client, or
a frame that renders its scenes on the server, `docs/server-rendering.md`), it
dithers the RGBA down to the panel's few inks. By default that is the
Floyd-Steinberg packer every frame has always had. A frame can instead choose
[OpenDisplay epaper-dithering](https://github.com/OpenDisplay/epaper-dithering)
(MIT): ink matching in OKLab, serpentine error diffusion, exposure in linear
light and an optional Direct Binary Search (DBS) pass tuned to the viewing
distance.

| Side | Code | Pinned by |
|---|---|---|
| Backend | `backend/app/utils/panel_dither.py`, `pack_image_for_panel` in `backend/app/api/embedded_device.py` | `backend/app/utils/tests/test_panel_dither.py` (writes and replays the fixtures) |
| Cloud | `cloud/apps/auth-web/src/lib/panel-dither.ts`, `panel-pack.ts` | `panel-dither.test.ts` (replays the same fixtures) |
| Settings | `frontend/src/scenes/frame/panels/FrameSettings/fields/ditheringSection.tsx` | `workspace-surfaces.test.ts` |

The backend uses the `epaper-dithering` Python wheel; the cloud uses the
`@opendisplay/epaper-dithering` npm package. Both are builds of the same Rust
core, so both planes pack the same bytes for the same picture:
`docs/dither-fixtures.json` holds five cases (Spectra 6 with and without DBS,
7-colour, BWYR, a measured palette) that each plane replays byte for byte.

## Why

Floyd-Steinberg in sRGB with plain RGB distance works, but it matches inks by
how far apart their numbers are, not by how they look. On a Spectra 6 panel
that shows as hue shifts in skin and skies and as grain in flat areas. In
side-by-side tests on a 4" and a 7.3" Spectra 6 panel, photos viewed from
50 cm, OpenDisplay with the panel's measured palette, DBS on and brightness
+30% was picked as best every time, over Floyd-Steinberg and over OpenDisplay
without DBS.

It works best with a measured `palette` (the colours this panel really
shows, set in the Palette section above it). With the stock palette it still
matches by perception but aims at idealised inks the panel cannot show.

## The setting

`dither` is a JSON object on the frame, or `null` for Floyd-Steinberg:

| Key | Values | Default |
|---|---|---|
| `method` | `"floydSteinberg"` or `"opendisplay"` | anything but `"opendisplay"` means Floyd-Steinberg |
| `algorithm` | `burkes`, `floyd_steinberg`, `atkinson`, `stucki`, `sierra`, `sierra_lite`, `jarvis_judice_ninke`, `ordered` | `burkes` |
| `exposure` | 0.5 to 2.0, multiplied in linear light (the screen shows it as brightness −50% to +100%) | 1.0 |
| `dbs` | `true` to refine with Direct Binary Search | `false` |
| `viewingDistanceCm` | 10 to 500, what DBS tunes the dot pattern for | 50 |

Unknown keys and out-of-range values are refused when saved (backend:
`validate_dither`; cloud: `ditherProblem`). When read, the packer fills in the
defaults and clamps (`normalize_dither` / `normalizeDither`), and that
normalised value is part of the render fingerprint, so changing the setting
moves the ETag and the frame fetches a new picture.

It is the plane's own setting and never reaches the device: it is not in
`docs/cloud-frames-contract.json` (a device refuses keys it does not know),
does not mark the frame as needing a deploy, and changes nothing for a frame
that renders its own scenes, which keeps the device's Floyd-Steinberg. The
backend stores it in the frame's `dither` column; the cloud in
`frames.dither`, written by `POST /api/frames/{id}/dither` (owner only,
audited as `frame.dither_changed`), the same way as `voice_permissions`.

## What the packer does

Only the palette formats (`BWYR`, 7-colour, Spectra 6) are dithered this
way; black-and-white and grey panels keep their packer. The palette is the
one `docs/server-rendering.md` describes (a photo's own, then the frame's
measured `palette`, then the stock table). Each entry is named by its ink and
handed to OpenDisplay as a measured palette (`Palette.from_srgb(...,
measured=True)`), so it knows which colour is "red" even when the measured red
is dark brown. OpenDisplay's indices are then mapped back to the panel's wire
indices, Spectra 6's hole at 4 included.

When a frame dithers with OpenDisplay, the render's automatic fit of drawn
images (`colors.autoFit`) is off, whatever the frame's setting says.
OpenDisplay does its own tone mapping to the measured palette; fitting first
squeezes the picture twice. On a 7.3" Spectra 6 panel with auto fit set to
"on", that pushed the share of black dots in a photo from 24 % to 47 %. The
Colors section says so when OpenDisplay is chosen; the setting still applies
to a frame that renders its own scenes.

DBS needs the panel's pixel density. It is read from the panel's name
(`EPD_7in3e` is 7.3", `inky_impression_4` is 4") with the picture's size;
when the name says nothing it assumes 127 ppi (a 7.3" 800×480 panel).

### Cost

Measured on an Apple M-series laptop, DBS on: 0.5 to 0.8 s for a 4" or 7.3"
panel, 3.4 to 4 s for a 13.3" one. Above 2 million pixels the DBS pass is
skipped (the error diffusion still runs). The work happens where the
Floyd-Steinberg packing already does, off the event loop (the backend's
worker thread, the cloud's render worker), and the result is deterministic,
so an unchanged picture keeps its ETag.

### When it cannot run

If the package is missing or the call fails, the packer falls back to
Floyd-Steinberg and logs `server_render.dither_fallback` once (backend), or
the render worker packs without it (cloud). A frame always gets a picture.
