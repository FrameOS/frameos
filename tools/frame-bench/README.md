# Frame bench

A hardware bench for every FrameOS frame on this machine's USB, and every
Raspberry Pi frame listed for it over SSH (`--linux-only`): scenes,
layouts and desktop windows, input, switch storms, a memory soak, a hanging
backend, reboots and server rendering, with a report of crashes, OOMs, slow
paths and regressions against an earlier run, and a scored benchmark that
runs the same on every firmware, releases and dev builds alike.

```
frameos/.venv/bin/python3 tools/frame-bench/bench.py discover
frameos/.venv/bin/python3 tools/frame-bench/bench.py run --rediscover
frameos/.venv/bin/python3 tools/frame-bench/bench.py html     # ../frameos-benchmarks/index.html
```

- How to set it up, what each suite does and how to read a run's report:
  `.claude/skills/frame-bench/SKILL.md`.
- The boards are shared between sessions: book one before touching it
  (`boards.py`, `~/.frameos-bench/BOOKINGS.md`; the skill's "Booking a
  board"). `bench.py run` books what it benches and waits for the rest.
- The scores (categories, formula, noise, what is not measured): `SCORES.md`.
- The results are their own repo, [FrameOS/frameos-benchmarks](https://github.com/FrameOS/frameos-benchmarks)
  (the page: <https://frameos.github.io/frameos-benchmarks/>): clone it beside
  this checkout (`../frameos-benchmarks`, or set `$FRAMEOS_BENCHMARKS`). Every
  run adds its records to `data/*.jsonl` there, ready for a database
  (`SCHEMA.md` there), and `html` writes its `index.html`.
- The benchmark scenes: `benchmarks/<name>/app.tsx` (the JPEG is made by
  `benchmarks/image/make_photo.py`); the board list: `boards.json`.
