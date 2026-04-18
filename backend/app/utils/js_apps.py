from __future__ import annotations

import json
import os
from functools import lru_cache
import subprocess
import tempfile
from pathlib import Path

JS_APP_SOURCE_FILES = ("app.ts", "app.js")
COMPILED_JS_APP_FILENAME = "app.compiled.js"
GLOBAL_NAME = "__frameosModule"
REPO_ROOT = Path(__file__).resolve().parents[3]


def find_js_app_source_filename(app_dir: str) -> str | None:
    for filename in JS_APP_SOURCE_FILES:
        path = os.path.join(app_dir, filename)
        if os.path.exists(path):
            return filename
    return None


def is_js_app_dir(app_dir: str) -> bool:
    return find_js_app_source_filename(app_dir) is not None


@lru_cache(maxsize=1)
def _npm_global_node_modules_root() -> Path | None:
    proc = subprocess.run(
        ["npm", "root", "-g"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        return None
    root = Path(proc.stdout.strip())
    return root if root.exists() else None


@lru_cache(maxsize=1)
def _find_esbuild_module_path() -> Path:
    candidates: list[Path] = []
    env_path = os.environ.get("FRAMEOS_ESBUILD_MAIN")
    if env_path:
        candidates.append(Path(env_path))

    candidates.extend(
        [
            REPO_ROOT / "frontend" / "node_modules" / "esbuild" / "lib" / "main.js",
            REPO_ROOT / "node_modules" / "esbuild" / "lib" / "main.js",
            REPO_ROOT / "frameos" / "frontend" / "node_modules" / "esbuild" / "lib" / "main.js",
        ]
    )

    global_root = _npm_global_node_modules_root()
    if global_root is not None:
        candidates.append(global_root / "esbuild" / "lib" / "main.js")

    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()

    raise RuntimeError(
        "Unable to locate esbuild. Install frontend dependencies with `pnpm install`, "
        "install `esbuild` globally, or set FRAMEOS_ESBUILD_MAIN."
    )


def _node_esbuild_script() -> str:
    return """
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const esbuildModulePath = process.argv[1];
const mode = process.argv[2];
const esbuildModule = await import(pathToFileURL(esbuildModulePath).href);
const esbuild = esbuildModule.default ?? esbuildModule;

function serializeError(error) {
  if (!error) {
    return [{ text: 'Unknown esbuild error', location: { line: 1, column: 0 } }];
  }
  if (Array.isArray(error.errors) && error.errors.length > 0) {
    return error.errors;
  }
  return [{ text: String(error.message || error), location: { line: 1, column: 0 } }];
}

try {
  if (mode === 'validate') {
    const filename = process.argv[3];
    const source = fs.readFileSync(process.argv[4], 'utf8');
    const loader = filename.endsWith('.ts') ? 'ts' : 'js';
    await esbuild.transform(source, {
      loader,
      format: 'esm',
      target: 'es2020',
      sourcemap: false,
      sourcefile: filename,
      charset: 'utf8',
    });
    process.stdout.write(JSON.stringify({ ok: true }));
  } else if (mode === 'build') {
    const entry = process.argv[3];
    const outfile = process.argv[4];
    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      format: 'iife',
      globalName: '__frameosModule',
      platform: 'neutral',
      target: 'es2020',
      charset: 'utf8',
      logLevel: 'silent',
      outfile,
      sourcemap: false,
    });
    process.stdout.write(JSON.stringify({ ok: true }));
  } else {
    throw new Error(`Unknown mode: ${mode}`);
  }
} catch (error) {
  process.stderr.write(JSON.stringify({ ok: false, errors: serializeError(error) }));
  process.exit(1);
}
"""


def _run_esbuild(args: list[str]) -> tuple[bool, dict]:
    esbuild_module_path = _find_esbuild_module_path()
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", _node_esbuild_script(), str(esbuild_module_path), *args],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode == 0:
        stdout = proc.stdout.strip() or '{"ok": true}'
        return True, json.loads(stdout)

    stderr = proc.stderr.strip() or '{"ok": false, "errors": [{"text": "esbuild failed"}]}'
    try:
        return False, json.loads(stderr)
    except json.JSONDecodeError:
        return False, {"ok": False, "errors": [{"text": stderr, "location": {"line": 1, "column": 0}}]}


def validate_js_source(filename: str, source: str) -> list[dict]:
    with tempfile.NamedTemporaryFile(mode="w", suffix=Path(filename).suffix, delete=False) as tmp:
        tmp.write(source)
        tmp_path = tmp.name

    try:
        try:
            ok, payload = _run_esbuild(["validate", filename, tmp_path])
        except RuntimeError as exc:
            return [{"line": 1, "column": 1, "error": str(exc)}]
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

    if ok:
        return []

    errors: list[dict] = []
    for error in payload.get("errors", []):
        location = error.get("location") or {}
        errors.append(
            {
                "line": int(location.get("line", 1)),
                "column": int(location.get("column", 0)) + 1,
                "error": error.get("text", "Unknown JavaScript error"),
            }
        )
    return errors


def compile_js_app_dir(app_dir: str, out_filename: str = COMPILED_JS_APP_FILENAME) -> str | None:
    source_filename = find_js_app_source_filename(app_dir)
    if not source_filename:
        return None

    entry_path = os.path.join(app_dir, source_filename)
    output_path = os.path.join(app_dir, out_filename)
    ok, payload = _run_esbuild(["build", entry_path, output_path])
    if not ok:
        errors = "; ".join(error.get("text", "Unknown JavaScript build error") for error in payload.get("errors", []))
        raise RuntimeError(f"Failed to compile JS app in {app_dir}: {errors}")
    return output_path


def _resolve_js_source_path(app_dir: Path, filename: str) -> Path:
    source_path = Path(filename)
    if source_path.is_absolute():
        raise ValueError(f"Invalid JS source filename: {filename!r}")

    app_dir_path = app_dir.resolve()
    resolved_path = (app_dir_path / source_path).resolve()
    try:
        resolved_path.relative_to(app_dir_path)
    except ValueError as exc:
        raise ValueError(f"Invalid JS source filename: {filename!r}") from exc
    return resolved_path


def compile_js_app_sources(sources: dict[str, str], out_filename: str = COMPILED_JS_APP_FILENAME) -> dict[str, str]:
    normalized_sources = {
        str(filename): str(source)
        for filename, source in sources.items()
        if isinstance(filename, str) and isinstance(source, str)
    }
    if not normalized_sources:
        return {}

    if not any(filename in normalized_sources for filename in JS_APP_SOURCE_FILES):
        return dict(normalized_sources)

    with tempfile.TemporaryDirectory() as app_dir:
        app_dir_path = Path(app_dir)
        resolved_paths: dict[str, Path] = {}
        path_to_filename: dict[Path, str] = {}
        for filename in normalized_sources:
            path = _resolve_js_source_path(app_dir_path, filename)
            if path in path_to_filename and path_to_filename[path] != filename:
                raise ValueError(
                    f"Duplicate JS source filename after normalization: {filename!r} conflicts with"
                    f" {path_to_filename[path]!r}"
                )
            resolved_paths[filename] = path
            path_to_filename[path] = filename

        for filename, source in normalized_sources.items():
            path = resolved_paths[filename]
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(source, encoding="utf-8")

        output_path = compile_js_app_dir(app_dir, out_filename)
        if output_path is None:
            return dict(normalized_sources)

        compiled_sources = dict(normalized_sources)
        compiled_sources[out_filename] = Path(output_path).read_text(encoding="utf-8")
        return compiled_sources
