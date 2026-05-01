from __future__ import annotations

import json
import os
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


def _run_sucrase(filename: str, source_path: str) -> tuple[bool, dict]:
    repo_root = Path(__file__).resolve().parents[3]
    vendor_path = repo_root / "frameos" / "assets" / "compiled" / "vendor" / "sucrase.js"
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", _node_sucrase_script(), filename, source_path, str(vendor_path)],
        cwd=repo_root,
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode == 0:
        stdout = proc.stdout.strip() or '{"ok": true}'
        return True, json.loads(stdout)

    stderr = proc.stderr.strip() or '{"ok": false, "errors": [{"text": "sucrase failed"}]}'
    try:
        return False, json.loads(stderr)
    except json.JSONDecodeError:
        return False, {"ok": False, "errors": [{"text": stderr, "location": {"line": 1, "column": 0}}]}


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
