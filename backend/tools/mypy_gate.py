#!/usr/bin/env python3
"""Ratcheting mypy gate for the backend.

mypy reports ~600 errors in code that predates any type-check gate. Fixing
them all before gating would mean no gate for months, and disabling the
error codes involved (arg-type, union-attr, …) would gate nothing at all. So
this script runs mypy and compares its output with ``mypy-baseline.txt``:

* an error not in the baseline fails the run (new debt is refused),
* an error in the baseline that mypy no longer reports is only reported
  (run with ``--update`` to shrink the baseline),
* line numbers are ignored so an unrelated edit above an old error does not
  turn it into a "new" one.

Usage:  python tools/mypy_gate.py [--update]   (from backend/)
"""

from __future__ import annotations

import collections
import re
import subprocess
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
BASELINE = BACKEND / "mypy-baseline.txt"
LINE = re.compile(r"^(?P<file>[^:]+):(?P<line>\d+)(?::\d+)?: (?P<level>error|note): (?P<message>.*)$")


def run_mypy() -> list[str]:
    proc = subprocess.run(
        [sys.executable, "-m", "mypy", "app"],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode not in (0, 1):
        sys.stderr.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        raise SystemExit(f"mypy failed to run (exit {proc.returncode})")
    keys: list[str] = []
    for raw in proc.stdout.splitlines():
        match = LINE.match(raw)
        if not match or match.group("level") != "error":
            continue
        keys.append(f"{match.group('file')}: {match.group('message')}")
    return keys


def read_baseline() -> list[str]:
    if not BASELINE.is_file():
        return []
    return [line.rstrip("\n") for line in BASELINE.read_text(encoding="utf-8").splitlines() if line.strip()]


def main(argv: list[str]) -> int:
    update = "--update" in argv
    current = collections.Counter(run_mypy())
    baseline = collections.Counter(read_baseline())

    new = current - baseline
    fixed = baseline - current

    if update:
        BASELINE.write_text("".join(f"{key}\n" for key in sorted(current.elements())), encoding="utf-8")
        print(f"mypy baseline written: {sum(current.values())} errors in {BASELINE.name}")
        return 0

    if fixed:
        print(f"{sum(fixed.values())} baseline error(s) no longer reported — run `python tools/mypy_gate.py --update`:")
        for key, count in sorted(fixed.items()):
            print(f"  - {key}" + (f"  (x{count})" if count > 1 else ""))
    if new:
        print(f"{sum(new.values())} new mypy error(s) not in the baseline:")
        for key, count in sorted(new.items()):
            print(f"  + {key}" + (f"  (x{count})" if count > 1 else ""))
        return 1
    print(f"mypy: no new errors ({sum(current.values())} baselined)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
