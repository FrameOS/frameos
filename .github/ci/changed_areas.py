#!/usr/bin/env python3
"""Which heavy CI jobs a pull request needs, from the files it changes.

The `changes` job of pull-request-tests.yml and e2e-docker.yml runs this and
the heavy jobs read its outputs in their `if:`. There are no required checks
on this repository, so a job skipped here is simply absent from the run.

Every area starts from RELEVANT and is switched off only by a file list made
entirely of paths that area provably does not read: an unknown or new path
runs everything, so a rule missing below costs minutes, never a check. Pushes
(and anything but a pull request) run every area, as does a pull request whose
file list cannot be read in full.

Rules are (glob, relevant) pairs tried in order, first match wins; `**`
crosses directories, `*` does not, and a pattern with no slash matches at the
repository root only.

    GH_TOKEN=... PR=123 python3 .github/ci/changed_areas.py   (GITHUB_OUTPUT gets the flags)
    python3 .github/ci/changed_areas.py --files a b c          (prints them)
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys

# Paths no heavy job reads: the iOS app (ios.yml has its own triggers), prose,
# the runner pool's host scripts, and workflows that are not these two.
COMMON_IRRELEVANT = [
    "ios/**",
    "*.md",
    "docs/**/*.md",
    "tools/gha-runners/**",
    "mprocs.yaml",
    ".github/workflows/ios.yml",
    ".github/workflows/cloud-ci.yml",
    ".github/workflows/npm-publish.yml",
    ".github/workflows/discord-release.yml",
    ".github/workflows/sync-timezones.yml",
    ".github/workflows/ghcr-cache-retention.yml",
    ".github/workflows/buildroot-base-image.yml",
    ".github/workflows/frameos-buildroot.yml",
    ".github/workflows/frameos-cross.yml",
    ".github/workflows/frameos-cross-toolchain.yml",
    ".github/workflows/docker-publish-multi.yml",
]


def irrelevant(*patterns: str) -> list[tuple[str, bool]]:
    return [(pattern, False) for pattern in (*COMMON_IRRELEVANT, *patterns)]


AREAS: dict[str, list[tuple[str, bool]]] = {
    # The Nim test shards, pixie's suite, the ESP32 Nim compile check and the
    # Kitchen sink: frameos/ itself, repo/ (assets), docs/ fixtures, the root
    # manifests, frontend/ (the frame's admin bundle is built from
    # frontend/src, and prepare_assets.py fingerprints it), e2e/scenes (read by
    # test_interpreter_svg_paint_strips.nim).
    "runtime": [
        ("e2e/scenes/**", True),
        *irrelevant(
            "cloud/**",
            "cloud-frontend/**",
            "embedded/**",
            "backend/**",
            "e2e/**",
            "scripts/**",
            "tools/**",
            ".github/workflows/e2e-docker.yml",
        ),
    ],
    # e2e/Makefile's renderer snapshots: the runtime plus the backend files the
    # Makefile copies into its build (codegen, drivers, js_apps.py).
    "renderer": [
        ("backend/app/codegen/**", True),
        ("backend/app/drivers/**", True),
        ("backend/app/utils/js_apps.py", True),
        *irrelevant(
            "cloud/**",
            "cloud-frontend/**",
            "embedded/**",
            "backend/**",
            "e2e/frontend-visual/**",
            "e2e/deploy/**",
            "scripts/**",
            "tools/**",
            ".github/workflows/e2e-docker.yml",
        ),
    ],
    # Playwright: the backend it serves, the three bundles it builds (frontend,
    # frameos/frontend, cloud-frontend; the workspace preview takes
    # frameos/wasm/src), the scenes the seed loads. cloud/ is not read: the
    # cloud specs serve cloud-frontend's bundle and route the API themselves.
    "frontend_e2e": [
        ("e2e/frontend-visual/**", True),
        ("e2e/scenes/**", True),
        *irrelevant(
            "cloud/**",
            "embedded/**",
            "e2e/**",
            "scripts/**",
            ".github/workflows/e2e-docker.yml",
        ),
    ],
    # The SSH deploy, runtime and Buildroot E2E tests: backend + runtime.
    "deploy": [
        *irrelevant(
            "cloud/**",
            "cloud-frontend/**",
            "embedded/**",
            "e2e/frontend-visual/**",
            ".github/workflows/e2e-docker.yml",
        ),
    ],
    # The runtime Docker image: what the Dockerfile's runtime target copies.
    "docker": [
        ("embedded/esp32/partitions*.csv", True),
        *irrelevant(
            "cloud/**",
            "embedded/**",
            "e2e/**",
            "docs/**",
            "scripts/**",
            ".github/workflows/pull-request-tests.yml",
        ),
    ],
    # The ESP32 firmware: frameos/ (the Nim runtime and its assets, so
    # frontend/ too), embedded/esp32, repo/, docs/ fixtures, the Dockerfile's
    # toolchain stage.
    "esp32": [
        *irrelevant(
            "cloud/**",
            "cloud-frontend/**",
            "embedded/pico/**",
            "e2e/**",
            "backend/**",
            "scripts/**",
            ".github/workflows/pull-request-tests.yml",
        ),
    ],
}


def glob_regex(pattern: str) -> re.Pattern[str]:
    out = []
    i = 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        elif pattern[i] == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile("".join(out) + r"\Z")


COMPILED = {area: [(glob_regex(p), relevant) for p, relevant in rules] for area, rules in AREAS.items()}


def file_is_relevant(area: str, path: str) -> bool:
    for regex, relevant in COMPILED[area]:
        if regex.match(path):
            return relevant
    return True


def classify(files: list[str]) -> dict[str, bool]:
    return {area: any(file_is_relevant(area, f) for f in files) for area in AREAS}


def pull_request_files(repo: str, number: str) -> list[str] | None:
    """Every path the PR touches, the old side of renames included. None when
    the list cannot be had in full (the API stops at 3000 files)."""
    try:
        out = subprocess.run(
            ["gh", "api", "--paginate", f"repos/{repo}/pulls/{number}/files?per_page=100",
             "--jq", ".[] | [.filename, (.previous_filename // empty)] | .[]"],
            check=True, capture_output=True, text=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError) as error:
        print(f"::warning::could not list the pull request's files ({error}); running every job", file=sys.stderr)
        return None
    files = sorted({line for line in out.splitlines() if line})
    if len(files) >= 3000:
        print("::warning::3000 or more files changed; running every job", file=sys.stderr)
        return None
    return files


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] == "--files":
        print(json.dumps(classify(sys.argv[2:]), indent=2))
        return 0

    files: list[str] | None = None
    if os.environ.get("GITHUB_EVENT_NAME") == "pull_request":
        files = pull_request_files(os.environ["GITHUB_REPOSITORY"], os.environ["PR"])
    flags = classify(files) if files is not None else {area: True for area in AREAS}

    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        for area, run in flags.items():
            output.write(f"{area}={'true' if run else 'false'}\n")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as out:
            reason = f"{len(files)} changed files" if files is not None else "not a pull request: everything runs"
            out.write(f"### Jobs this run needs ({reason})\n\n| area | runs |\n| --- | --- |\n")
            for area, run in flags.items():
                out.write(f"| {area} | {'yes' if run else 'skipped'} |\n")
    for area, run in flags.items():
        print(f"{area}: {'run' if run else 'skip'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
