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
| Settings | `frontend/src/scenes/frame/panels/FrameSettings/fields/ditheringSection.tsx`, `frontend/src/utils/ditherPresets.ts` | `dither-presets.test.ts`, `workspace-surfaces.test.ts` |

The backend uses the `epaper-dithering` Python wheel; the cloud uses the
`@opendisplay/epaper-dithering` npm package. Both are builds of the same Rust
core, so both planes pack the same bytes for the same picture:
`docs/dither-fixtures.json` holds six cases (Spectra 6 with and without DBS,
7-colour, BWYR, a measured palette, every fine-tuning setting with a density
override) that each plane replays byte for byte.

## Why

Floyd-Steinberg in sRGB with plain RGB distance works, but it matches inks by
how far apart their numbers are, not by how they look. On a Spectra 6 panel
that shows as hue shifts in skin and skies and as grain in flat areas. In
side-by-side tests on a 4" and a 7.3" Spectra 6 panel, photos viewed from
50 cm, OpenDisplay with the panel's measured palette, DBS on and brightness
+30% was picked as best every time, over Floyd-Steinberg and over OpenDisplay
without DBS.

DBS tuned for 50 cm, though, drew red outlines where light skin meets a dark
background: red is these panels' mid-lightness ink, and DBS placed it along
such edges. In a second round on both panels (DBS tuned for 50, 30 and 20 cm,
and no DBS, photos with skin against dark clothes), 30 cm looked best on
each, so 30 cm is the default.

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
| `viewingDistanceCm` | 10 to 500, what DBS tunes the dot pattern for | 30 |
| `saturation` | 0 to 2, OKLab chroma multiplier (0 = grey) | 1.0 |
| `shadows` | 0 to 1, shadow lift | 0 |
| `highlights` | 0 to 1, highlight compression | 0 |
| `tone` | 0 to 1, maps lightness onto the panel's darkest and lightest ink (shadow detail for lighter blacks) | 0 |
| `gamut` | 0 to 1, pulls colours the panel cannot show towards ones it can | 0 |
| `ppi` | 50 to 600, or `null`: overrides the density DBS reads from the panel's name | `null` |

OpenDisplay runs these in a fixed order before it matches inks: exposure,
saturation, shadows and highlights, tone, gamut. Each is a no-op at its
default, so a stored value only needs the keys it changes.

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

## Presets and fine tuning

The Dithering section works like Colors: a preset, and fine tuning folded
away under it.

- **Built-in presets** (`BUILTIN_DITHER_PRESETS` in
  `frontend/src/utils/ditherPresets.ts`): Floyd-Steinberg (the FrameOS
  default, `null`), OpenDisplay (no tone changes) and OpenDisplay photo
  (+30 %, DBS at 30 cm: the settings picked on the real panels above). Only
  settings tried on a panel are offered as built-ins.
- **Fine tuning** shows every setting in the table above, with a preview of
  the frame's current image dithered as the panel will show it, in the
  palette's colours. The preview runs the npm package's WASM build in the
  browser, the same Rust core as both planes' packers, so it shows the
  picture the frame will get; it is loaded only when fine tuning is opened.
- **Your own presets**: fine tuning saves the current settings under a name.
  They are kept in the plane's settings as the `ditherPresets` group (a list
  of `{id, name, dither}`, at most 50; backend `validate_dither_presets`,
  cloud `readDitherPresets`, each `dither` checked like the frame's own), so
  every frame of the project (backend) or account (cloud) offers them. A
  frame stores the values, not the preset: editing or deleting a preset
  later changes no frame. The section shows which preset a frame's values
  match, or "Custom settings".

Presets never reach a device: on the cloud, the service settings a frame
pulls take string maps only (`revealedServiceSettings`).

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
when the name says nothing it assumes 127 ppi (a 7.3" 800×480 panel), unless
the frame sets `ppi`.

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
