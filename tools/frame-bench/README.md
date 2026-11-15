# Frame bench

A hardware bench for every FrameOS frame on this machine's USB: scenes,
layouts and desktop windows, input, switch storms, a memory soak, a hanging
backend, reboots and server rendering, with a report of crashes, OOMs, slow
paths and regressions against an earlier run.

```
frameos/.venv/bin/python3 tools/frame-bench/bench.py discover
frameos/.venv/bin/python3 tools/frame-bench/bench.py run --rediscover
```

How to set it up, what each suite does and how to read the report:
`.claude/skills/frame-bench/SKILL.md`.
