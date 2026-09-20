#!/usr/bin/env python3
"""Cut the hash-pinned entries for a resolved set of packages out of the lock.

    hashed_subset.py requirements.txt resolved.txt > runtime.txt

`requirements.txt` is the committed, hash-carrying lock (backend/bin/
compile-requirements). `resolved.txt` is a plain `name==version` list — what
`uv pip compile requirements.docker.in -c requirements.txt` resolves for the
runtime image, a subset of the lock. The output is that subset with the
lock's own `--hash` lines, ready for `uv pip install --require-hashes`.

The hashes must come from the repository, not from the index at build time —
hashes fetched next to the download they are meant to check prove nothing. So
a resolved package the lock does not carry AT THAT VERSION is an error, never
a silent unhashed install: add it to requirements.in and recompile.

Stdlib only: the Dockerfile runs it before anything is installed.
"""

from __future__ import annotations

import re
import sys

_REQUIREMENT = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?==([^\s;\\]+)")


def normalize(name: str) -> str:
    """PEP 503: the lock says `python-jose`, a resolver may say `python_jose`."""
    return re.sub(r"[-_.]+", "-", name).lower()


def parse_lock(text: str) -> dict[str, tuple[str, list[str]]]:
    """name -> (version, the entry's lines: the requirement and its hashes)."""
    entries: dict[str, tuple[str, list[str]]] = {}
    current: list[str] | None = None
    for line in text.splitlines():
        match = _REQUIREMENT.match(line)
        if match:
            current = [line]
            entries[normalize(match.group(1))] = (match.group(3), current)
        elif current is not None and line.strip().startswith("--hash="):
            current.append(line)
        else:
            # A "# via" comment or a blank line ends the entry.
            current = None
    return entries


def parse_resolved(text: str) -> list[tuple[str, str]]:
    resolved = []
    for line in text.splitlines():
        match = _REQUIREMENT.match(line.strip())
        if match:
            resolved.append((normalize(match.group(1)), match.group(3)))
    return resolved


def hashed_subset(lock_text: str, resolved_text: str) -> str:
    lock = parse_lock(lock_text)
    resolved = parse_resolved(resolved_text)
    if not resolved:
        raise SystemExit("hashed_subset: the resolved list names no packages")
    problems = []
    lines: list[str] = []
    for name, version in resolved:
        if name not in lock:
            problems.append(f"{name}=={version} is not in the lock")
            continue
        locked_version, entry = lock[name]
        if locked_version != version:
            problems.append(f"{name} resolved to {version} but the lock pins {locked_version}")
        elif len(entry) < 2:
            problems.append(f"{name}=={version} has no --hash lines in the lock")
        else:
            # The last hash line of an entry that is followed by a comment ends
            # in a continuation backslash; it must not swallow the next entry.
            lines.extend(entry[:-1])
            lines.append(entry[-1].rstrip().rstrip("\\").rstrip())
    if problems:
        raise SystemExit(
            "hashed_subset: the runtime resolution left the committed lock:\n  "
            + "\n  ".join(problems)
            + "\nAdd the package to backend/requirements.in and run backend/bin/compile-requirements."
        )
    return "\n".join(lines) + "\n"


def main(argv: list[str]) -> None:
    if len(argv) != 3:
        raise SystemExit(__doc__)
    with open(argv[1], encoding="utf-8") as lock, open(argv[2], encoding="utf-8") as resolved:
        sys.stdout.write(hashed_subset(lock.read(), resolved.read()))


if __name__ == "__main__":
    main(sys.argv)
