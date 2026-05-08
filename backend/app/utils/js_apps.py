from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

JS_APP_SOURCE_FILES = ("app.ts", "app.js", "app.tsx", "app.jsx")


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


def _node_sucrase_script() -> str:
    return """
import fs from 'node:fs';

const filename = process.argv[1];
const source = fs.readFileSync(process.argv[2], 'utf8');
const vendorPath = process.argv[3];

async function transpile() {
  if (vendorPath && fs.existsSync(vendorPath)) {
    globalThis.eval(fs.readFileSync(vendorPath, 'utf8'));
    return globalThis.__frameosTranspile(source, { filePath: filename });
  }

  const { transform } = await import('sucrase');
  return transform(source, {
    filePath: filename,
    transforms: ['typescript', 'jsx'],
    jsxRuntime: 'classic',
    jsxPragma: '__frameosJsx',
    jsxFragmentPragma: '__frameosFragment',
    production: true,
  }).code;
}

try {
  await transpile();
  process.stdout.write(JSON.stringify({ ok: true }));
} catch (error) {
  process.stderr.write(JSON.stringify({
    ok: false,
    errors: [{
      text: String(error?.message || error || 'Unknown JavaScript error'),
      location: {
        line: Number(error?.loc?.line || 1),
        column: Number(error?.loc?.column || 1),
      },
    }],
  }));
  process.exit(1);
}
"""


def _json_payload_from_process(proc: subprocess.CompletedProcess[str], fallback: str) -> tuple[bool, dict]:
    output = proc.stdout.strip() or proc.stderr.strip()
    if not output:
        output = fallback
    try:
        payload = json.loads(output)
    except json.JSONDecodeError:
        payload = {"ok": False, "errors": [{"text": output, "location": {"line": 1, "column": 0}}]}
    return proc.returncode == 0, payload


def _quickjs_binary(repo_root: Path) -> str | None:
    candidates = [
        repo_root / "frameos" / "quickjs" / "qjs",
        Path("/app/frameos/quickjs/qjs"),
    ]
    for candidate in candidates:
        if candidate.exists() and os.access(candidate, os.X_OK):
            return str(candidate)
    return shutil.which("qjs")


def _run_quickjs_sucrase(filename: str, source_path: str, repo_root: Path, vendor_path: Path) -> tuple[bool, dict] | None:
    qjs = _quickjs_binary(repo_root)
    if not qjs or not vendor_path.exists():
        return None

    script_path = Path(__file__).resolve().with_name("js_validate_quickjs.js")
    proc = subprocess.run(
        [qjs, "--std", str(script_path), filename, source_path, str(vendor_path)],
        cwd=repo_root,
        capture_output=True,
        text=True,
        check=False,
    )
    ok, payload = _json_payload_from_process(
        proc,
        '{"ok": false, "errors": [{"text": "quickjs sucrase validation failed"}]}',
    )
    if ok or payload.get("errors"):
        return ok, payload
    return None


def _run_node_sucrase(filename: str, source_path: str, repo_root: Path, vendor_path: Path) -> tuple[bool, dict]:
    node = shutil.which("node")
    if not node:
        return False, {"ok": False, "errors": [{"text": "JavaScript validation requires QuickJS or Node", "location": {"line": 1, "column": 0}}]}

    proc = subprocess.run(
        [node, "--input-type=module", "-e", _node_sucrase_script(), filename, source_path, str(vendor_path)],
        cwd=repo_root,
        capture_output=True,
        text=True,
        check=False,
    )
    return _json_payload_from_process(
        proc,
        '{"ok": false, "errors": [{"text": "sucrase failed"}]}',
    )


def _run_sucrase(filename: str, source_path: str) -> tuple[bool, dict]:
    repo_root = Path(__file__).resolve().parents[3]
    vendor_path = repo_root / "frameos" / "assets" / "compiled" / "vendor" / "sucrase.js"
    quickjs_result = _run_quickjs_sucrase(filename, source_path, repo_root, vendor_path)
    if quickjs_result is not None:
        return quickjs_result
    return _run_node_sucrase(filename, source_path, repo_root, vendor_path)


def validate_js_source(filename: str, source: str) -> list[dict]:
    tmp_path = ""
    try:
        with tempfile.NamedTemporaryFile("w", suffix=Path(filename).suffix, encoding="utf-8", delete=False) as tmp:
            tmp.write(source)
            tmp_path = str(tmp.name)

        ok, payload = _run_sucrase(filename, tmp_path)
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
