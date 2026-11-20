# Bench records

What `tools/frame-bench/bench.py` measured, as data: JSON Lines, one table
a file, append-only, the shape a database takes later (each file is a table,
each line a row, the keys below its columns). Written by
`framebench/records.py`; read by `framebench/scoring.py` and `charts.py`.

- **Append-only.** A finished `bench.py run` adds its rows (`--no-record` to
  skip); `bench.py import [<run-dir> ...]` backfills any run directory, old
  or new, and never adds a run twice (key below). Nothing is rewritten: a
  mistake is fixed by a new import under a new `schema`, not by editing rows.
- **Summaries only.** Raw console logs and `run.json` stay in
  `~/.frameos-bench/<run>/`; these files hold the numbers.
- **`schema`** on `boards`, `runs`, `images` is 1. A change of meaning bumps it.

## boards.jsonl — one row per board identity

| column | |
|---|---|
| `board_id` | **key**: `<module>/<display>/<target>/psram<MB>m/flash<MB>m`, e.g. `seeed_reterminal_e1003/EPD_10in3/esp32-s3/psram8m/flash32m`. What the board IS, never the port it sits on. |
| `module`, `display`, `target` | from `usb_api status` (`board.module`, `board.display`, `board.target`) |
| `name` | `tools/frame-bench/boards.json`, else the backend frame's name |
| `psram_bytes`, `flash_bytes` | `memory.psramTotal`, `storage.flashBytes` |
| `panel_width`, `panel_height`, `panel_mpx` | the panel in pixels (`render.previewWidth/Height`, else boards.json) |
| `panel_kind`, `panel_colors` | `lcd` / `epaper`; `rgb565`, `bw`, `grey16`, `spectra6` |
| `touch` | the bench can tap it |
| `chip` | boards.json `chips[target]`: cores, MHz, `jpeg_hw`, `ppa` |
| `first_seen` | the run it was first imported from |

## runs.jsonl — one row per run x board

| column | |
|---|---|
| `rig`, `run_id`, `board_id`, `device` | **key**. `rig`: the machine (`$FRAMEOS_BENCH_RIG`, default `devbox`); `run_id`: the run directory's name (`YYYYMMDD-HHMMSS`, local time); `device`: which unit of that board (`frame<frame id>`), so two boards of one kind in a run are two rows |
| `started` | ISO 8601 with the rig's offset |
| `mode` | `full` (every scene and layout), `sampled` (a slow panel's turn, the default run), `quick`, `partial` (chosen suites, scenes or frames). Only like runs compare (SCORES.md). |
| `bench_version`, `bench_sha`, `workload` | the bench code (`framebench.BENCH_VERSION`, the commit of `tools/frame-bench`), the benchmark scenes' workload; 1 / null / null for runs before they were recorded |
| `frameos_version` | the release line (`2026.11.12`) |
| `build` | what the board ran: a release (`2026.11.12`, known by the image's ELF sha, never by the printed version), a dev build `<base>+<sha>` (`2026.11.12+49345dbb4`), or a bench build with no sha `<printed>+elf.<elf8>` |
| `channel` | `release`, `main`, `branch:<name>`, `local` (built on the bench, printing a release's or a made-up number), `unknown` |
| `git_sha`, `elf_sha16`, `release_platform`, `version_reported` | the pieces `build` was made from |
| `frame_name`, `kind` | the backend frame's name; `local` / `thin` / `pico` |
| `suites`, `seconds` | what ran, and for how long |
| `scene_set` | hash of the board's own scene set (ids, sizes): its per-scene times compare only while it stays |

## metrics.jsonl — one row per run x board x metric

| column | |
|---|---|
| `rig`, `run_id`, `board_id`, `device` | the run row it belongs to |
| `metric` | dotted name, below |
| `scene` | for per-scene metrics only (`scene.*`): the scene's name |
| `value`, `unit` | the median where there were several samples |
| `n`, `min`, `p25`, `p75`, `max` | the samples behind `value`, when there were several |

Metric families (the code in `records.frame_metrics` is the list):

- `bench.*` — the benchmark scenes (SCORES.md): `bench.cpu.{int,float,json,str}_ms`
  (the app's own clock), `bench.<scene>.{render,done,pack,cold,cold_render}_ms`,
  `bench.{raster,ui}.net_ms` (minus the baseline), `bench.anim.fps`,
  `bench.anim.target_fps`, `bench.ui.tap_ms`, `bench.switch_ms`.
- `mem.*` — `mem.idle.*` (status), `mem.min_ever.*` / `mem.largest.*`
  (`heapinfo` after the benchmark), `mem.bench.psram_low`,
  `mem.desktop.psram_low`, `mem.soak.{psram,internal}_drift` (bytes a round,
  least squares; a steady fall is a leak), `mem.soak.psram_low`.
- `resp.*` — `resp.boot.{bootup,first_render}_ms`, `resp.{switcher,settings}.open_ms`,
  `resp.input.{next,previous}_ms`.
- `scene.*` (per scene) and `scenes.*` (the board's own set: `count`,
  `failed`, `warm_ms`, `switch_ms` medians over its scenes).
- `desktop.*`, `code.open_ms`, `storm.settled_s`, `offline.switch_ms`,
  `thin.*` (a plane-rendered board), `net.wifi_rssi`, `power.battery_mv`.
- `stab.{crash,fail,slow,note}` and `stab.kind.<kind>` — the run's issues
  for that board, merged repeats counted.

## images.jsonl — one row per firmware image

| column | |
|---|---|
| `source`, `version`, `platform` | **key** (with `elf_sha16` for `local`). `release` rows come from each release's `-size.json` asset (`bench.py sizes v2026.11.12 ...`), `local` ones from a build (`--local <app.bin>:<version>:<platform>`) |
| `chip`, `git_sha`, `published`, `elf_sha16` | `elf_sha16` read at offset 0xb0 of the app image (`--elf`): how a run is known to be on a release |
| `app_bytes`, `slot_bytes`, `slot_headroom_bytes`, `slot_used_pct` | the app image against the OTA slot it must fit |
| `merged_bytes`, `flash_bytes`, `flash_code`, `flash_rodata`, `used_diram`, `diram_total` | from the size report |
| `groups` | flash bytes per part (`FrameOS core (Nim)`, `QuickJS`, ...) |

## Into a database

Each file maps to a table with the key above as its primary key (`metrics`:
`rig, run_id, board_id, device, metric, scene`); `runs.board_id` and
`metrics.(rig, run_id, board_id, device)` are foreign keys. `chip`, `groups`
and `suites` are JSON columns.
