# Frame bench

A hardware bench for every FrameOS frame on this machine's USB: scenes,
layouts and desktop windows, input, switch storms, a memory soak, a hanging
backend, reboots and server rendering, with a report of crashes, OOMs, slow
paths and regressions against an earlier run, and a scored benchmark that
runs the same on every firmware, releases and dev builds alike.

```
frameos/.venv/bin/python3 tools/frame-bench/bench.py discover
frameos/.venv/bin/python3 tools/frame-bench/bench.py run --rediscover
frameos/.venv/bin/python3 tools/frame-bench/bench.py html     # results/report.html
```

- How to set it up, what each suite does and how to read a run's report:
  `.claude/skills/frame-bench/SKILL.md`.
- The scores (categories, formula, noise, what is not measured): `SCORES.md`.
- The records every run adds (`results/*.jsonl`), ready for a database:
  `results/SCHEMA.md`.
- The benchmark scenes: `benchmarks/<name>/app.tsx` (the JPEG is made by
  `benchmarks/image/make_photo.py`); the board list: `boards.json`.
