#!/usr/bin/env python3
"""Keep frameos/nimble.paths in step with frameos/nimble.lock.

`nimble setup` writes nimble.paths from the lock, but nothing ran it again
when the lock moved: the Makefile and build_wasm.sh wrote only a missing file,
so a checkout kept compiling against the packages of the day it was set up
(2026-10-29: pixie two months behind the lock, and every JSX test with a
nested <svg> failing for it). config.nims refuses a stale file; the build
entry points (the Makefile, build_wasm.sh, the ESP32's build_nim.sh) run this
first.

    python3 tools/nimble_paths.py          # refresh nimble.paths when stale
    python3 tools/nimble_paths.py --check  # say what is stale, exit 1 if so

Stale is: no nimble.paths, a locked package missing from it at the lock's
version and checksum (the package directory is `<name>-<version>-<sha1>`), a
path that is not a locked package, or a path that is not on disk. A refresh is
`nimble setup`, and `nimble install -d` first when the locked packages are not
installed yet.
"""

import json
import re
import subprocess
import sys
from pathlib import Path

FRAMEOS_DIR = Path(__file__).resolve().parent.parent


def stale_reasons() -> list[str]:
    lock = json.loads((FRAMEOS_DIR / "nimble.lock").read_text())["packages"]
    paths_file = FRAMEOS_DIR / "nimble.paths"
    if not paths_file.exists():
        return ["nimble.paths is missing"]
    dirs = re.findall(r'--path:"([^"]+)"', paths_file.read_text())
    on_paths = {Path(d).name: d for d in dirs}
    reasons = []
    for name, package in lock.items():
        wanted = f"{name}-{package['version']}-{package['checksums']['sha1']}"
        if wanted not in on_paths:
            have = [n for n in on_paths if n.rsplit("-", 2)[0] == name]
            reasons.append(f"{name}: the lock has {package['vcsRevision'][:7]} ({wanted}), "
                           f"nimble.paths {have[0] if have else 'nothing'}")
    for package_dir, path in on_paths.items():
        if package_dir.rsplit("-", 2)[0] not in lock:
            reasons.append(f"{package_dir}: not in nimble.lock")
        elif not Path(path).is_dir():
            reasons.append(f"{path}: not on disk")
    return reasons


def nimble(*args: str) -> None:
    subprocess.run(["nimble", *args], cwd=FRAMEOS_DIR, check=True)


def main() -> int:
    reasons = stale_reasons()
    if not reasons:
        return 0
    if "--check" in sys.argv[1:]:
        print("frameos/nimble.paths is stale:", *reasons, sep="\n  ", file=sys.stderr)
        return 1
    print("refreshing frameos/nimble.paths:", *reasons, sep="\n  ", file=sys.stderr)
    nimble("setup", "--silent")
    if stale_reasons():
        # The locked packages are not all installed: fetch them, then again.
        nimble("install", "-d", "-y")
        nimble("setup", "--silent")
    reasons = stale_reasons()
    if reasons:
        print("frameos/nimble.paths is still stale after nimble setup:", *reasons, sep="\n  ", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
