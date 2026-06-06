from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path

JS_APP_SOURCE_FILES = ("app.ts", "app.js", "app.tsx", "app.jsx")
_NATIVE_TRANSPILER_LOCK = threading.Lock()


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


def _native_transpiler_sources(frameos_root: Path) -> list[Path]:
    return [
        frameos_root / "tools" / "native_js_transpile.nim",
        *(frameos_root / "src" / "frameos" / "js_runtime").glob("*.nim"),
    ]


def _native_transpiler_bin(frameos_root: Path) -> Path:
    suffix = ".exe" if os.name == "nt" else ""
    return frameos_root / "build" / f"native_js_transpile{suffix}"


def _native_transpiler_is_current(binary: Path, frameos_root: Path) -> bool:
    if not binary.exists():
        return False
    binary_mtime = binary.stat().st_mtime
    return all(
        path.exists() and path.stat().st_mtime <= binary_mtime
        for path in _native_transpiler_sources(frameos_root)
    )


def _ensure_native_transpiler(repo_root: Path) -> tuple[Path | None, dict | None]:
    override = os.environ.get("FRAMEOS_NATIVE_JS_TRANSPILE")
    if override:
        binary = Path(override)
        if binary.exists():
            return binary, None
        return None, {
            "ok": False,
            "errors": [
                {
                    "text": f"FRAMEOS_NATIVE_JS_TRANSPILE does not exist: {override}",
                    "location": {"line": 1, "column": 1},
                }
            ],
        }

    frameos_root = repo_root / "frameos"
    binary = _native_transpiler_bin(frameos_root)
    if _native_transpiler_is_current(binary, frameos_root):
        return binary, None

    nim = shutil.which("nim")
    if not nim:
        return None, {
            "ok": False,
            "errors": [
                {
                    "text": "JavaScript validation requires Nim to build the FrameOS native transpiler",
                    "location": {"line": 1, "column": 1},
                }
            ],
        }

    with _NATIVE_TRANSPILER_LOCK:
        if _native_transpiler_is_current(binary, frameos_root):
            return binary, None
        binary.parent.mkdir(parents=True, exist_ok=True)
        proc = subprocess.run(
            [
                nim,
                "c",
                "--nimCache:build/nimcache/native_js_transpile",
                f"--out:build/{binary.name}",
                "tools/native_js_transpile.nim",
            ],
            cwd=frameos_root,
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode != 0:
            output = (proc.stderr or proc.stdout).strip() or "Failed to build FrameOS native JavaScript transpiler"
            return None, {
                "ok": False,
                "errors": [{"text": output, "location": {"line": 1, "column": 1}}],
            }
    return binary, None


def _source_map_generated_position(source_map: dict | None, line: int, column: int) -> tuple[int, int]:
    if not source_map:
        return line, column

    mapped_line = 0
    generated_to_source_line = source_map.get("generatedToSourceLine") or []
    if 0 < line < len(generated_to_source_line):
        try:
            mapped_line = int(generated_to_source_line[line])
        except (TypeError, ValueError):
            mapped_line = 0

    mapped_column = max(1, column)
    best_segment: dict | None = None
    for segment in source_map.get("segments") or []:
        try:
            segment_line = int(segment.get("generatedLine", 0))
            segment_column = int(segment.get("generatedColumn", 0))
        except (TypeError, ValueError):
            continue
        if segment_line == line and segment_column <= column:
            if best_segment is None or segment_column > int(best_segment.get("generatedColumn", 0)):
                best_segment = segment

    if best_segment is not None:
        try:
            mapped_line = int(best_segment.get("sourceLine", mapped_line))
            source_column = int(best_segment.get("sourceColumn", 1))
            generated_column = int(best_segment.get("generatedColumn", 1))
        except (TypeError, ValueError):
            return mapped_line or line, mapped_column
        mapped_column = max(1, source_column + (column - generated_column))

    return mapped_line or line, mapped_column


def _path_line_prefixes(path: str) -> tuple[str, ...]:
    paths = [path, os.path.realpath(path)]
    if path.startswith("/var/"):
        paths.append("/private" + path)
    return tuple(dict.fromkeys(path + ":" for path in paths))


def _node_check_error_payload(
    proc: subprocess.CompletedProcess[str],
    source: str,
    generated_path: str,
    source_map: dict | None = None,
) -> dict:
    output = (proc.stderr or proc.stdout).strip()
    line = 1
    column = 1
    found_column = False
    text = "Unknown JavaScript error"
    source_lines = source.splitlines() or [""]
    line_prefixes = _path_line_prefixes(generated_path)

    for raw_line in output.splitlines():
        if raw_line.startswith(line_prefixes):
            try:
                line = int(raw_line.rsplit(":", 1)[1])
            except ValueError:
                line = 1
        elif raw_line.startswith("SyntaxError:"):
            text = raw_line.removeprefix("SyntaxError:").strip() or raw_line

    output_lines = output.splitlines()
    for index, raw_line in enumerate(output_lines):
        if raw_line.startswith(line_prefixes) and index + 2 < len(output_lines):
            caret_line = output_lines[index + 2]
            caret_index = caret_line.find("^")
            if caret_index >= 0:
                column = caret_index + 1
                found_column = True
                break

    source_line, source_column = _source_map_generated_position(source_map, line, column)
    source_line = min(max(1, source_line), len(source_lines))
    if not found_column:
        source_column = len(source_lines[source_line - 1]) + 1

    return {
        "ok": False,
        "errors": [
            {
                "text": text,
                "location": {"line": source_line, "column": max(1, source_column)},
            }
        ],
    }


def _run_node_syntax_check(code: str, source: str, source_map: dict | None = None) -> tuple[bool, dict]:
    node = shutil.which("node")
    if not node:
        return False, {
            "ok": False,
            "errors": [
                {
                    "text": "JavaScript validation requires Node",
                    "location": {"line": 1, "column": 1},
                }
            ],
        }

    tmp_path = ""
    try:
        with tempfile.NamedTemporaryFile("w", suffix=".js", encoding="utf-8", delete=False) as tmp:
            tmp.write(code)
            tmp_path = str(tmp.name)
        proc = subprocess.run([node, "--check", tmp_path], capture_output=True, text=True, check=False)
        if proc.returncode == 0:
            return True, {"ok": True}
        return False, _node_check_error_payload(proc, source, tmp_path, source_map)
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.remove(tmp_path)


def _run_native_frameos_transpiler(filename: str, source_path: str, source: str, repo_root: Path) -> tuple[bool, dict]:
    binary, error_payload = _ensure_native_transpiler(repo_root)
    if error_payload is not None or binary is None:
        return False, error_payload or {
            "ok": False,
            "errors": [
                {
                    "text": "FrameOS native JavaScript transpiler is unavailable",
                    "location": {"line": 1, "column": 1},
                }
            ],
        }

    proc = subprocess.run(
        [str(binary), "module-json", source_path],
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
                        "text": f"Failed to transform {filename}",
                        "location": {"line": 1, "column": 1},
                    }
                ],
            }
        ),
    )
    if not ok or not payload.get("ok", ok):
        return False, payload

    code = payload.get("code")
    if not isinstance(code, str):
        return False, {
            "ok": False,
            "errors": [
                {
                    "text": f"Failed to transform {filename}",
                    "location": {"line": 1, "column": 1},
                }
            ],
        }
    return _run_node_syntax_check(code, source, payload.get("sourceMap"))


def _run_frameos_js_validation(filename: str, source_path: str, source: str) -> tuple[bool, dict]:
    repo_root = Path(__file__).resolve().parents[3]
    return _run_native_frameos_transpiler(filename, source_path, source, repo_root)


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
