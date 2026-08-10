"""Content-addressed tag for the disposable SSH target image.

The deploy E2E test builds a Debian image with a compiler toolchain in it, which
takes ~54 s of a ~4.5 minute test — and rebuilds it on every run, because the
tag was a fixed ``:latest`` that told nobody whether the existing image matched
the current Dockerfile.

Naming the image after a hash of its build context makes reuse safe: a matching
tag can only have been built from exactly these files, so the test can skip the
build when one is already present, and CI can pre-build it into the daemon (with
a layer cache) under the same name. Edit anything in this directory and the tag
changes, so a stale image is never silently reused.

Run as a script to print the tag, which is what the workflow does.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

IMAGE_NAME = "frameos-deploy-e2e-ssh-target"


def context_digest(context_dir: Path | None = None) -> str:
    """Short digest over every file in the build context, path names included."""
    root = context_dir or Path(__file__).parent
    digest = hashlib.sha256()
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        # This helper is part of the context but not part of the image, so
        # changing the tag logic must not invalidate the image it names.
        if path.name == Path(__file__).name:
            continue
        digest.update(path.relative_to(root).as_posix().encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()[:12]


def context_tag(context_dir: Path | None = None) -> str:
    return f"{IMAGE_NAME}:{context_digest(context_dir)}"


if __name__ == "__main__":
    print(context_tag())
