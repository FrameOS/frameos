#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Iterable, List

ROOT = Path(__file__).resolve().parent.parent
OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"
DEFAULT_MODEL = "gpt-5.5"
DEFAULT_MAX_OUTPUT_TOKENS = 2400
DEFAULT_TOTAL_PATCH_CHARS = 120_000
DEFAULT_PATCH_CHARS_PER_FILE = 8_000

DIFF_PREFIXES = (
    ".github/workflows/",
    "backend/",
    "frontend/src/",
    "frontend/*.json",
    "frameos/agent/",
    "frameos/frontend/src/",
    "frameos/src/",
    "repo/apps/",
    "repo/scenes/",
    "scripts/",
    "tools/",
)

DIFF_FILES = {
    ".dockerignore",
    "Dockerfile",
    "docker-compose.yml",
    "docker-entrypoint.sh",
    "package.json",
    "pnpm-workspace.yaml",
    "project-folders.json",
}

SKIP_PATCH_SUFFIXES = {
    ".bmp",
    ".db",
    ".gif",
    ".ico",
    ".jpg",
    ".jpeg",
    ".lock",
    ".pdf",
    ".png",
    ".snap",
    ".svg",
    ".tar",
    ".tgz",
    ".webp",
    ".zip",
}

SKIP_PATCH_NAMES = {
    "pnpm-lock.yaml",
    "versions.json",
}

SKIP_PATCH_PARTS = {
    "dist",
    "node_modules",
    "snapshots",
    "__pycache__",
}


def load_env_local() -> None:
    env_path = ROOT / ".env.local"
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", key):
            continue
        if key in os.environ:
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        os.environ[key] = value


def run_git(args: List[str], *, check: bool = True) -> str:
    process = subprocess.run(
        ["git", *args],
        cwd=ROOT,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if check and process.returncode != 0:
        raise SystemExit(f"git {' '.join(args)} failed:\n{process.stderr.strip()}")
    return process.stdout.strip()


def parse_int_env(name: str, default: int) -> int:
    value = os.environ.get(name)
    if not value:
        return default
    try:
        return int(value)
    except ValueError as exc:
        raise SystemExit(f"{name} must be an integer") from exc


def parse_args(argv: List[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate FrameOS release notes using the OpenAI API.")
    parser.add_argument("--version", required=True, help="Release version without the leading v.")
    parser.add_argument("--release-tag", required=True, help="Release tag, for example v2026.5.6.")
    parser.add_argument("--head", default="HEAD", help="Release commit/ref. Defaults to HEAD.")
    parser.add_argument("--base-ref", help="Previous release commit/tag. Defaults to the latest reachable v* tag.")
    parser.add_argument("--output", default="release-notes.md", help="Output Markdown file, or - for stdout.")
    parser.add_argument(
        "--model",
        default=os.environ.get("OPENAI_RELEASE_NOTES_MODEL", DEFAULT_MODEL),
        help=f"OpenAI model to use. Defaults to {DEFAULT_MODEL}, or OPENAI_RELEASE_NOTES_MODEL.",
    )
    parser.add_argument(
        "--max-output-tokens",
        type=int,
        default=parse_int_env("OPENAI_RELEASE_NOTES_MAX_OUTPUT_TOKENS", DEFAULT_MAX_OUTPUT_TOKENS),
    )
    parser.add_argument(
        "--max-total-patch-chars",
        type=int,
        default=parse_int_env("OPENAI_RELEASE_NOTES_MAX_PATCH_CHARS", DEFAULT_TOTAL_PATCH_CHARS),
    )
    parser.add_argument(
        "--max-patch-chars-per-file",
        type=int,
        default=parse_int_env("OPENAI_RELEASE_NOTES_MAX_PATCH_CHARS_PER_FILE", DEFAULT_PATCH_CHARS_PER_FILE),
    )
    parser.add_argument("--timeout", type=int, default=parse_int_env("OPENAI_RELEASE_NOTES_TIMEOUT", 120))
    parser.add_argument(
        "--dry-run-context",
        action="store_true",
        help="Print the git context that would be sent to OpenAI without calling the API.",
    )
    return parser.parse_args(argv)


def resolve_ref(ref: str) -> str:
    return run_git(["rev-parse", ref])


def find_previous_release_tag(head: str, release_tag: str) -> str | None:
    tags = run_git(["tag", "--merged", head, "--list", "v[0-9]*", "--sort=-v:refname"], check=False)
    for tag in tags.splitlines():
        tag = tag.strip()
        if tag and tag != release_tag:
            return tag
    return None


def git_range_args(base_ref: str | None, head: str) -> List[str]:
    if base_ref:
        return [base_ref, head]
    return ["--root", head]


def changed_paths(name_status: str) -> List[str]:
    paths: List[str] = []
    for line in name_status.splitlines():
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        status = parts[0]
        if status.startswith("D"):
            path = parts[1]
        else:
            path = parts[-1]
        paths.append(path)
    return paths


def prefix_match(path: str, pattern: str) -> bool:
    if "*" not in pattern:
        return path.startswith(pattern)
    prefix, suffix = pattern.split("*", 1)
    return path.startswith(prefix) and path.endswith(suffix)


def should_include_patch(path: str) -> bool:
    if path in SKIP_PATCH_NAMES:
        return False
    path_parts = set(Path(path).parts)
    if path_parts & SKIP_PATCH_PARTS:
        return False
    if Path(path).suffix.lower() in SKIP_PATCH_SUFFIXES:
        return False
    if path in DIFF_FILES:
        return True
    return any(prefix_match(path, prefix) for prefix in DIFF_PREFIXES)


def truncate(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    return text[:max_chars].rstrip() + "\n[... truncated ...]"


def selected_patches(
    base_ref: str | None,
    head: str,
    paths: Iterable[str],
    *,
    max_total_chars: int,
    max_per_file_chars: int,
) -> str:
    sections: List[str] = []
    remaining = max_total_chars
    omitted_count = 0

    for path in paths:
        if not should_include_patch(path):
            continue
        if remaining <= 0:
            omitted_count += 1
            continue

        diff_args = ["diff", "--find-renames", "--unified=60", *git_range_args(base_ref, head), "--", path]
        patch = run_git(diff_args, check=False)
        if not patch:
            continue

        patch = truncate(patch, min(max_per_file_chars, remaining))
        section = f"### {path}\n```diff\n{patch}\n```"
        sections.append(section)
        remaining -= len(section)

    if omitted_count:
        sections.append(f"{omitted_count} additional changed source file(s) omitted after the patch context limit.")

    if not sections:
        return "No selected source patches were available."
    return "\n\n".join(sections)


def build_release_context(args: argparse.Namespace, head: str, base_ref: str | None) -> str:
    range_args = git_range_args(base_ref, head)
    commit_range = f"{base_ref}..{head}" if base_ref else head
    previous = base_ref or "none"

    commit_log = run_git(["log", "--no-merges", "--pretty=format:%h %s", commit_range], check=False)
    if not commit_log:
        commit_log = "No non-merge commits found in this range."

    diff_stat = run_git(["diff", "--stat", "--find-renames", *range_args], check=False)
    if not diff_stat:
        diff_stat = "No file-level diff stat found."

    name_status = run_git(["diff", "--name-status", "--find-renames", *range_args], check=False)
    if not name_status:
        name_status = "No changed files found."

    patches = selected_patches(
        base_ref,
        head,
        changed_paths(name_status),
        max_total_chars=args.max_total_patch_chars,
        max_per_file_chars=args.max_patch_chars_per_file,
    )

    return "\n\n".join(
        [
            f"Release: FrameOS {args.version} ({args.release_tag})",
            f"Previous release ref: {previous}",
            f"Release commit: {head}",
            "Commit subjects:",
            commit_log,
            "Changed files:",
            name_status,
            "Diff stat:",
            diff_stat,
            "Selected source diffs:",
            patches,
        ]
    )


def release_notes_prompt() -> str:
    return """You write concise, user-facing GitHub release notes for FrameOS.

Use the provided commit subjects and actual source diffs. Prefer facts that are clearly supported by code changes.

Output Markdown only with exactly these sections:

## New features
## Bug fixes
## Maintenance

Rules:
- Include both the New features and Bug fixes sections even when one has no notable entries.
- Use bullets under each section.
- Keep each bullet specific and written for FrameOS users/operators.
- Mention UI, backend/API, runtime/device, deployment, and Home Assistant changes when relevant.
- Put tests, build, refactors, dependency bumps, and release automation in Maintenance unless they are directly
  user-facing.
- Do not mention versions.json, the OpenAI API, release note generation, or the prompt.
- If a section has no notable entries, write one bullet saying that no notable changes were found for that category.
"""


def extract_response_text(payload: dict) -> str:
    output_text = payload.get("output_text")
    if isinstance(output_text, str) and output_text.strip():
        return output_text.strip()

    parts: List[str] = []
    for item in payload.get("output", []):
        if not isinstance(item, dict):
            continue
        for content in item.get("content", []):
            if not isinstance(content, dict):
                continue
            if content.get("type") == "output_text" and isinstance(content.get("text"), str):
                parts.append(content["text"])
    text = "\n".join(parts).strip()
    if not text:
        raise SystemExit(f"OpenAI response did not contain text output:\n{json.dumps(payload, indent=2)[:2000]}")
    return text


def generate_notes(api_key: str, args: argparse.Namespace, context: str) -> str:
    request_payload = {
        "model": args.model,
        "input": [
            {"role": "developer", "content": release_notes_prompt()},
            {"role": "user", "content": context},
        ],
        "max_output_tokens": args.max_output_tokens,
        "store": False,
    }
    request = urllib.request.Request(
        OPENAI_RESPONSES_URL,
        data=json.dumps(request_payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=args.timeout) as response:
            response_payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"OpenAI API request failed with HTTP {exc.code}:\n{body[:2000]}") from exc
    except urllib.error.URLError as exc:
        raise SystemExit(f"OpenAI API request failed: {exc}") from exc

    return extract_response_text(response_payload)


def write_output(path: str, text: str) -> None:
    if path == "-":
        print(text)
        return
    output_path = Path(path)
    output_path.write_text(text.rstrip() + "\n", encoding="utf-8")


def main(argv: List[str] | None = None) -> int:
    load_env_local()
    args = parse_args(argv)

    head = resolve_ref(args.head)
    base_ref = args.base_ref or find_previous_release_tag(head, args.release_tag)
    if base_ref:
        base_ref = resolve_ref(base_ref)

    context = build_release_context(args, head, base_ref)
    if args.dry_run_context:
        write_output(args.output, context)
        return 0

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise SystemExit("OPENAI_API_KEY is required in the environment or .env.local to generate release notes.")

    notes = generate_notes(api_key, args, context)
    write_output(args.output, notes)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
