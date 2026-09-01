from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path

JS_APP_SOURCE_FILES = ("app.ts", "app.js", "app.tsx", "app.jsx")
_JS_CHECK_LOCK = threading.Lock()


def find_js_app_source_key(sources: dict | None) -> str | None:
    if not sources:
        return None
    for filename in JS_APP_SOURCE_FILES:
        if sources.get(filename) is not None:
            return filename
    return None


def find_js_app_source_filename(app_dir: str) -> str | None:
    for filename in JS_APP_SOURCE_FILES:
        path = os.path.join(app_dir, filename)
        if os.path.exists(path):
            return filename
    return None


def _json_payload_from_process(proc: subprocess.CompletedProcess[str], fallback: str) -> tuple[bool, dict]:
    output = proc.stdout.strip() or proc.stderr.strip()
    if not output:
        output = fallback
    try:
        payload = json.loads(output)
    except json.JSONDecodeError:
        payload = {"ok": False, "errors": [{"text": output, "location": {"line": 1, "column": 0}}]}
    return proc.returncode == 0, payload


def _js_check_sources(frameos_root: Path) -> list[Path]:
    return [
        frameos_root / "tools" / "js_check.nim",
        frameos_root / "src" / "frameos" / "js_runtime" / "burrito.nim",
    ]


def _js_check_bin(frameos_root: Path) -> Path:
    suffix = ".exe" if os.name == "nt" else ""
    return frameos_root / "build" / f"js_check{suffix}"


def _js_check_is_current(binary: Path, frameos_root: Path) -> bool:
    if not binary.exists():
        return False
    binary_mtime = binary.stat().st_mtime
    return all(
        path.exists() and path.stat().st_mtime <= binary_mtime
        for path in _js_check_sources(frameos_root)
    )


def _ensure_js_check(repo_root: Path) -> tuple[Path | None, dict | None]:
    """The checker links the runtime's own QuickJS (quickts), so a source that
    passes here is a source the frame will parse. Built on first use with the
    same Nim the deploy uses; FRAMEOS_JS_CHECK points at a prebuilt one."""
    override = os.environ.get("FRAMEOS_JS_CHECK")
    if override:
        binary = Path(override)
        if binary.exists():
            return binary, None
        return None, {
            "ok": False,
            "errors": [
                {
                    "text": f"FRAMEOS_JS_CHECK does not exist: {override}",
                    "location": {"line": 1, "column": 1},
                }
            ],
        }

    frameos_root = repo_root / "frameos"
    binary = _js_check_bin(frameos_root)
    if _js_check_is_current(binary, frameos_root):
        return binary, None

    nim = shutil.which("nim")
    if not nim:
        return None, {
            "ok": False,
            "errors": [
                {
                    "text": "JavaScript validation requires Nim to build the FrameOS syntax checker",
                    "location": {"line": 1, "column": 1},
                }
            ],
        }

    with _JS_CHECK_LOCK:
        if _js_check_is_current(binary, frameos_root):
            return binary, None
        binary.parent.mkdir(parents=True, exist_ok=True)
        proc = subprocess.run(
            [
                nim,
                "c",
                "-d:release",
                "--hints:off",
                "--nimCache:build/nimcache/js_check",
                f"--out:build/{binary.name}",
                "tools/js_check.nim",
            ],
            cwd=frameos_root,
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode != 0:
            output = (proc.stderr or proc.stdout).strip() or "Failed to build the FrameOS JavaScript syntax checker"
            return None, {
                "ok": False,
                "errors": [{"text": output, "location": {"line": 1, "column": 1}}],
            }
    return binary, None


def _run_frameos_js_validation(filename: str, source_path: str, source: str) -> tuple[bool, dict]:
    repo_root = Path(__file__).resolve().parents[3]
    binary, error_payload = _ensure_js_check(repo_root)
    if error_payload is not None or binary is None:
        return False, error_payload or {
            "ok": False,
            "errors": [
                {
                    "text": "FrameOS JavaScript syntax checker is unavailable",
                    "location": {"line": 1, "column": 1},
                }
            ],
        }

    proc = subprocess.run(
        [str(binary), source_path],
        cwd=repo_root / "frameos",
        capture_output=True,
        text=True,
        check=False,
    )
    ok, payload = _json_payload_from_process(
        proc,
        json.dumps(
            {
                "ok": False,
                "errors": [
                    {
                        "text": f"Failed to check {filename}",
                        "location": {"line": 1, "column": 1},
                    }
                ],
            }
        ),
    )
    return ok and bool(payload.get("ok", ok)), payload


def validate_js_source(filename: str, source: str) -> list[dict]:
    tmp_path = ""
    try:
        with tempfile.NamedTemporaryFile("w", suffix=Path(filename).suffix, encoding="utf-8", delete=False) as tmp:
            tmp.write(source)
            tmp_path = str(tmp.name)

        ok, payload = _run_frameos_js_validation(filename, tmp_path, source)
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.remove(tmp_path)

    if ok:
        return []

    errors: list[dict] = []
    for error in payload.get("errors", []):
        location = error.get("location") or {}
        errors.append(
            {
                "line": int(location.get("line", 1)),
                "column": int(location.get("column", 1)),
                "error": error.get("text", "Unknown JavaScript error"),
            }
        )
    return errors
