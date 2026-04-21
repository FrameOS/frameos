from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

JS_APP_SOURCE_FILES = ("app.ts",)


def find_js_app_source_filename(app_dir: str) -> str | None:
    for filename in JS_APP_SOURCE_FILES:
        path = os.path.join(app_dir, filename)
        if os.path.exists(path):
            return filename
    return None


def is_js_app_dir(app_dir: str) -> bool:
    return find_js_app_source_filename(app_dir) is not None


def _node_sucrase_script() -> str:
    return """
import { transform } from 'sucrase';
import fs from 'node:fs';

const filename = process.argv[1];
const source = fs.readFileSync(process.argv[2], 'utf8');

try {
  transform(source, {
    filePath: filename,
    transforms: ['typescript', 'jsx'],
    jsxRuntime: 'classic',
    jsxPragma: '__frameosJsx',
    jsxFragmentPragma: '__frameosFragment',
    production: true,
  });
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
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", _node_sucrase_script(), filename, source_path],
        cwd=Path(__file__).resolve().parents[3] / "frameos" / "frontend",
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
        tmp_dir = Path(__file__).resolve().parents[3] / ".tmp"
        tmp_dir.mkdir(exist_ok=True)
        with (tmp_dir / f"validate_{os.getpid()}{Path(filename).suffix}").open("w") as tmp:
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
