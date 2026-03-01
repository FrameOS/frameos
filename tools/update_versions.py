#!/usr/bin/env python3
import datetime as dt
import hashlib
import json
import subprocess
from pathlib import Path, PurePosixPath
from typing import Dict, List

ROOT = Path(__file__).resolve().parent.parent
PROJECTS_FILE = ROOT / "project-folders.json"
VERSIONS_FILE = ROOT / "versions.json"
DOCKERIGNORE_FILE = ROOT / ".dockerignore"


def _git_tracked_files() -> List[str]:
    output = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT)
    files = [p for p in output.decode("utf-8").split("\0") if p]
    return sorted(files)


def _load_dockerignore() -> List[str]:
    if not DOCKERIGNORE_FILE.exists():
        return []
    patterns: List[str] = []
    for raw_line in DOCKERIGNORE_FILE.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        patterns.append(line)
    return patterns


def _dockerignore_match(path: str, patterns: List[str]) -> bool:
    matched = False
    posix_path = PurePosixPath(path)

    for pattern in patterns:
        negated = pattern.startswith("!")
        if negated:
            pattern = pattern[1:]

        anchored = pattern.startswith("/")
        if anchored:
            pattern = pattern[1:]

        dir_pattern = pattern.endswith("/")
        if dir_pattern:
            pattern = pattern[:-1]

        if not pattern:
            continue

        candidates = [pattern]
        if not anchored and "/" not in pattern:
            candidates.append(f"**/{pattern}")

        hit = any(posix_path.match(candidate) for candidate in candidates)
        if dir_pattern and (path == pattern or path.startswith(f"{pattern}/") or f"/{pattern}/" in f"/{path}/"):
            hit = True

        if hit:
            matched = not negated

    return matched


def _included(path: str, includes: List[str], excludes: List[str]) -> bool:
    def matches(prefixes: List[str]) -> bool:
        for prefix in prefixes:
            clean = prefix.strip("/")
            if path == clean or path.startswith(f"{clean}/"):
                return True
        return False

    if not matches(includes):
        return False
    if excludes and matches(excludes):
        return False
    return True


def _hash_files(files: List[str]) -> str:
    digest = hashlib.sha1()
    for rel_path in files:
        file_path = ROOT / rel_path
        digest.update(rel_path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(file_path.read_bytes())
    return digest.hexdigest()


def _parse_version(value: str):
    base = value.split("+", 1)[0]
    year_s, month_s, patch_s = base.split(".")
    return int(year_s), int(month_s), int(patch_s)


def _next_calver(previous: str | None, today: dt.date) -> str:
    if previous:
        prev_year, prev_month, prev_patch = _parse_version(previous)
        if prev_year == today.year and prev_month == today.month:
            return f"{today.year}.{today.month}.{prev_patch + 1}"
    return f"{today.year}.{today.month}.0"


def _max_base_version(versions: Dict[str, str]) -> str | None:
    if not versions:
        return None
    bases = [value.split("+", 1)[0] for value in versions.values() if value]
    if not bases:
        return None
    return max(bases, key=_parse_version)


def _increment_base_version(version: str) -> str:
    year, month, patch = _parse_version(version)
    return f"{year}.{month}.{patch + 1}"


def main() -> int:
    projects_config = json.loads(PROJECTS_FILE.read_text(encoding="utf-8"))
    tracked_files = _git_tracked_files()
    dockerignore_patterns = _load_dockerignore()

    existing_versions: Dict[str, str] = {}
    if VERSIONS_FILE.exists():
        existing_versions = json.loads(VERSIONS_FILE.read_text(encoding="utf-8"))

    updated_versions: Dict[str, str] = dict(existing_versions)
    today = dt.datetime.utcnow().date()

    project_hashes: Dict[str, str] = {}
    changed_projects: List[str] = []

    for project_name, config in projects_config["projects"].items():
        includes = config.get("include", [])
        excludes = config.get("exclude", [])

        project_files = [
            path
            for path in tracked_files
            if _included(path, includes, excludes) and not _dockerignore_match(path, dockerignore_patterns)
        ]

        project_hash = _hash_files(project_files)
        project_hashes[project_name] = project_hash
        previous = existing_versions.get(project_name)
        previous_hash = previous.split("+", 1)[1] if previous and "+" in previous else None

        if previous_hash == project_hash:
            updated_versions[project_name] = previous
            continue

        changed_projects.append(project_name)

    if changed_projects:
        max_existing_base = _max_base_version(existing_versions)
        if max_existing_base:
            next_version = _increment_base_version(max_existing_base)
        else:
            next_version = _next_calver(None, today)

        for project_name in changed_projects:
            updated_versions[project_name] = f"{next_version}+{project_hashes[project_name]}"

    ordered_projects = list(projects_config["projects"].keys())
    ordered_versions = {name: updated_versions[name] for name in ordered_projects if name in updated_versions}

    output = json.dumps(ordered_versions, indent=2) + "\n"
    VERSIONS_FILE.write_text(output, encoding="utf-8")

    changed = "yes" if ordered_versions != existing_versions else "no"
    print(f"versions_updated={changed}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
