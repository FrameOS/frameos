#!/usr/bin/env python3
"""Measure what storing scenes as zip packages would change (docs/scene-packages.md).

Reads every repo scene (repo/scenes/samples and repo/scenes/gallery, each a
scenes.json array) and reports, per scene and for the whole set:

- the scene's JSON as the planes send it (compact) and as a Pi keeps it
  (scenes.json.gz: pretty, indent 4, gzipped whole);
- how much of it is graph (scene.json without apps and code), JS app files
  and code nodes' code, and what JSON string escaping adds to those sources;
- the same scene as a zip in the Code editor's file layout (scene.json,
  apps/<app>/<file>, code/<node>.js), stored and deflated per entry, and the
  zip's own headers;
- what each costs on an ESP32's SPIFFS (page units, fos_spiffs_footprint.c)
  as one file per scene, one zip per scene, or one file per entry;
- with --history N: the last N commits that changed a sample, as the bytes a
  per-scene patch (today) and a per-entry patch (a package) would send.

Nothing here writes outside --out (default frameos/build/scene-packages).

    python3 frameos/tools/measure_scene_packages.py [--history 300] [--json] [--probe-inputs]

--probe-inputs also writes the whole set as a Pi's scenes.json, as an
uploadScenes body and with the app sources emptied, for
frameos/tools/scene_parse_probe.nim.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import statistics
import subprocess
import sys
import zipfile
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCENE_DIRS = [ROOT / "repo" / "scenes" / "samples", ROOT / "repo" / "scenes" / "gallery"]

# fos_spiffs_footprint.c, for the two page sizes the boards use
# (256 B: the 8 MB layouts' 1 MB /state; 512 B: the 32 MB layout's 24 MB).
PAGE_HEADER = 5
INDEX_PAGE_HEADER = 8
INDEX_HEADER_FIXED = INDEX_PAGE_HEADER + 4 + 1
PAGE_REF = 2
NAME_LEN = 32  # CONFIG_SPIFFS_OBJ_NAME_LEN
META_LEN = 4  # CONFIG_SPIFFS_META_LENGTH (IDF default)


def spiffs_pages(size: int, page: int) -> int:
    data = page - PAGE_HEADER
    data_pages = max(1, (size + data - 1) // data)
    first_refs = (page - (INDEX_HEADER_FIXED + NAME_LEN + META_LEN)) // PAGE_REF
    more_refs = (page - INDEX_PAGE_HEADER) // PAGE_REF
    index_pages = 1
    if data_pages > first_refs:
        index_pages += (data_pages - first_refs + more_refs - 1) // more_refs
    return data_pages + index_pages


def spiffs_bytes(size: int, page: int) -> int:
    return spiffs_pages(size, page) * page


def compact(value) -> bytes:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()


def files_of(scene: dict) -> dict[str, bytes]:
    """The Code editor's layout (repo/scenes/samples/Code editor, filesOf):
    scene.json without apps and code, apps/<app>/<file>, code/<node>.js."""
    files: dict[str, bytes] = {}
    base = {k: v for k, v in scene.items() if k != "apps"}
    nodes = []
    for node in scene.get("nodes") or []:
        data = node.get("data") if isinstance(node, dict) else None
        if isinstance(data, dict) and node.get("type") == "code" and isinstance(data.get("codeJS"), str):
            files[f"code/{node['id']}.js"] = data["codeJS"].encode()
            data = {k: v for k, v in data.items() if k != "codeJS"}
            node = {**node, "data": data}
        nodes.append(node)
    base["nodes"] = nodes
    for app_id, app in (scene.get("apps") or {}).items():
        if not isinstance(app, dict):
            continue
        meta = {k: v for k, v in app.items() if k != "sources"}
        sources = app.get("sources") or {}
        for name, text in sources.items():
            if isinstance(text, str):
                files[f"apps/{app_id}/{name}"] = text.encode()
        if meta and "config.json" not in sources:
            files[f"apps/{app_id}/app.json"] = compact(meta)
    files = {"scene.json": compact(base), **files}
    return files


def zip_of(files: dict[str, bytes], method: int, level: int | None = None) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=method, compresslevel=level) as z:
        for name, data in files.items():
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = method
            z.writestr(info, data, compresslevel=level)
    return buf.getvalue()


def zip_hybrid(files: dict[str, bytes]) -> bytes:
    """scene.json stored (first, so a streaming reader sees it as JSON right
    after its 30-byte local header), every other entry deflated."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, data in files.items():
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED if name == "scene.json" else zipfile.ZIP_DEFLATED
            z.writestr(info, data, compresslevel=9)
    return buf.getvalue()


def deflate_raw(data: bytes, level: int = 9) -> int:
    c = zlib.compressobj(level, zlib.DEFLATED, -15)
    return len(c.compress(data) + c.flush())


def load_scenes() -> list[tuple[str, dict]]:
    out = []
    for base in SCENE_DIRS:
        for path in sorted(base.glob("*/scenes.json")):
            for scene in json.loads(path.read_text()):
                out.append((f"{base.name}/{path.parent.name}", scene))
    return out


def measure_scene(label: str, scene: dict) -> dict:
    js = compact(scene)
    files = files_of(scene)
    graph = len(files["scene.json"])
    apps = sum(len(v) for k, v in files.items() if k.startswith("apps/"))
    tests = sum(len(v) for k, v in files.items() if k.startswith("apps/") and ".test." in k)
    code = sum(len(v) for k, v in files.items() if k.startswith("code/"))
    stored = zip_of(files, zipfile.ZIP_STORED)
    deflated = zip_of(files, zipfile.ZIP_DEFLATED, 9)
    hybrid = zip_hybrid(files)
    largest_entry = max(len(v) for v in files.values())
    no_tests = {k: v for k, v in files.items() if ".test." not in k}
    return {
        "label": label,
        "id": scene.get("id"),
        "name": scene.get("name"),
        "json": len(js),
        "json_deflate": deflate_raw(js),
        "graph": graph,
        "apps": apps,
        "tests": tests,
        "code": code,
        "entries": len(files),
        "raw_files": sum(len(v) for v in files.values()),
        "zip_stored": len(stored),
        "zip_deflated": len(deflated),
        "zip_hybrid": len(hybrid),
        "esp32_json": len(js) - sum(len(json.dumps(v.decode(), ensure_ascii=False)) for k, v in files.items() if ".test." in k),
        "hashes": {k: hashlib.sha256(v).hexdigest() for k, v in no_tests.items()},
        "sizes": {k: len(v) for k, v in files.items()},
        "largest_entry": largest_entry,
        "spiffs": {
            str(page): {
                "json_file": spiffs_bytes(len(js), page),
                "zip_stored_file": spiffs_bytes(len(stored), page),
                "zip_deflated_file": spiffs_bytes(len(deflated), page),
                "zip_hybrid_file": spiffs_bytes(len(hybrid), page),
                "file_per_entry": sum(spiffs_bytes(len(v), page) for v in files.values()),
                "files_per_entry": len(files),
            }
            for page in (256, 512)
        },
    }


def kb(n: float) -> str:
    return f"{n / 1024:,.1f} KB"


def pct(a: float, b: float) -> str:
    return f"{100.0 * a / b:.1f}%" if b else "-"


def history(limit: int) -> dict:
    """The last `limit` commits touching a sample's scenes.json: what a
    per-scene patch (the whole changed scene) and a per-entry patch (the
    changed entries, deflated or not) would have carried."""
    log = subprocess.run(
        ["git", "-C", str(ROOT), "log", f"-{limit}", "--format=%H", "--", "repo/scenes/samples/*/scenes.json"],
        capture_output=True, text=True, check=True,
    ).stdout.split()
    per_scene = per_entry = per_entry_deflated = per_scene_deflated = 0
    changes = 0
    graph_only = 0
    for sha in log:
        names = subprocess.run(
            ["git", "-C", str(ROOT), "diff-tree", "--no-commit-id", "--name-only", "-r", sha, "--",
             "repo/scenes/samples/*/scenes.json"],
            capture_output=True, text=True, check=True,
        ).stdout.split("\n")
        for name in filter(None, names):
            def show(rev: str, name: str = name):
                r = subprocess.run(["git", "-C", str(ROOT), "show", f"{rev}:{name}"], capture_output=True,
                                   check=False)
                if r.returncode != 0:
                    return []
                try:
                    return json.loads(r.stdout)
                except ValueError:
                    return []
            old = {s.get("id"): s for s in show(f"{sha}^") if isinstance(s, dict)}
            new = {s.get("id"): s for s in show(sha) if isinstance(s, dict)}
            for sid, scene in new.items():
                before = old.get(sid)
                if before is not None and compact(before) == compact(scene):
                    continue
                changes += 1
                js = compact(scene)
                per_scene += len(js)
                per_scene_deflated += deflate_raw(js)
                nf = files_of(scene)
                of = files_of(before) if before else {}
                changed = {k: v for k, v in nf.items() if of.get(k) != v}
                if set(changed) == {"scene.json"}:
                    graph_only += 1
                per_entry += sum(len(v) for v in changed.values())
                per_entry_deflated += sum(deflate_raw(v) for v in changed.values())
    return {
        "commits": len(log),
        "scene_changes": changes,
        "graph_only_changes": graph_only,
        "per_scene_bytes": per_scene,
        "per_scene_deflated": per_scene_deflated,
        "per_entry_bytes": per_entry,
        "per_entry_deflated": per_entry_deflated,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--history", type=int, default=0, help="also replay the last N sample commits")
    parser.add_argument("--json", action="store_true", help="print the per-scene rows as JSON")
    parser.add_argument("--probe-inputs", action="store_true",
                        help="also write the inputs of tools/scene_parse_probe.nim to --out")
    parser.add_argument("--out", default=str(ROOT / "frameos" / "build" / "scene-packages"))
    args = parser.parse_args()

    scenes = load_scenes()
    rows = [measure_scene(label, scene) for label, scene in scenes]
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "rows.json").write_text(json.dumps(rows, indent=1))

    whole = [scene for _, scene in scenes]
    pretty = (json.dumps(whole, indent=4) + "\n").encode()
    if args.probe_inputs:
        (out / "all_scenes.json").write_bytes(pretty)
        (out / "upload.json").write_text(json.dumps({"scenes": whole}))
        bare = json.loads(json.dumps(whole))
        for scene in bare:
            for app in (scene.get("apps") or {}).values():
                if isinstance(app, dict):
                    app["sources"] = {}
        (out / "no_sources.json").write_text(json.dumps(bare, indent=4))
    tot = lambda key: sum(r[key] for r in rows)
    js = tot("json")

    print(f"{len(rows)} scenes in {len({r['label'] for r in rows})} repo folders\n")
    print("Whole set")
    print(f"  compact JSON (wire)            {kb(js):>12}")
    print(f"  pretty JSON (Pi scenes.json)   {kb(len(pretty)):>12}")
    print(f"  pretty, gzipped whole (.gz)    {kb(len(gzip.compress(pretty, 9))):>12}")
    print(f"  compact, deflated whole        {kb(deflate_raw(compact(whole))):>12}")
    print(f"  compact, deflated per scene    {kb(tot('json_deflate')):>12}")
    print(f"  zip per scene, stored          {kb(tot('zip_stored')):>12}  (files {kb(tot('raw_files'))}, headers {kb(tot('zip_stored') - tot('raw_files'))})")
    print(f"  zip per scene, deflated        {kb(tot('zip_deflated')):>12}")
    print(f"  zip, scene.json stored + rest deflated {kb(tot('zip_hybrid')):>4}")
    print(f"  compact JSON, *.test.* stripped (what an ESP32 is sent) {kb(tot('esp32_json'))}")
    unique = {}
    for r in rows:
        for name, digest in r["hashes"].items():
            unique[digest] = r["sizes"][name]
    print(f"  entries kept once by content hash (no tests) {kb(sum(unique.values()))}"
          f"  of {kb(sum(r['sizes'][n] for r in rows for n in r['hashes']))}")
    print()
    print("What a scene is made of (sum over the set)")
    print(f"  graph (scene.json)             {kb(tot('graph')):>12}  {pct(tot('graph'), tot('raw_files'))}")
    print(f"  JS app files                   {kb(tot('apps')):>12}  {pct(tot('apps'), tot('raw_files'))}"
          f"  (of which *.test.* {kb(tot('tests'))})")
    print(f"  code nodes' code               {kb(tot('code')):>12}  {pct(tot('code'), tot('raw_files'))}")
    print(f"  JSON escaping of the sources   {kb(js - tot('raw_files')):>12}  (compact JSON minus the files it holds)")
    print()

    jsons = sorted(r["json"] for r in rows)
    print("Per scene, compact JSON")
    print(f"  median {kb(statistics.median(jsons))}, p90 {kb(jsons[int(len(jsons) * 0.9)])}, max {kb(jsons[-1])}")
    with_apps = [r for r in rows if r["apps"]]
    print(f"  {len(with_apps)} of {len(rows)} scenes carry JS apps; apps are "
          f"{pct(sum(r['apps'] for r in with_apps), sum(r['raw_files'] for r in with_apps))} of those scenes")
    entries = sorted(r["entries"] for r in rows)
    print(f"  entries per package: median {statistics.median(entries)}, max {entries[-1]}")
    print()
    print("Largest scenes")
    print(f"  {'scene':38} {'json':>9} {'graph':>9} {'apps':>9} {'tests':>9} {'zip st':>9} {'zip dfl':>9} {'json dfl':>9} {'n':>3}")
    for r in sorted(rows, key=lambda r: -r["json"])[:12]:
        print(f"  {r['label'].split('/', 1)[1][:38]:38} {kb(r['json']):>9} {kb(r['graph']):>9} {kb(r['apps']):>9} "
              f"{kb(r['tests']):>9} {kb(r['zip_stored']):>9} {kb(r['zip_deflated']):>9} {kb(r['json_deflate']):>9} {r['entries']:>3}")
    print()
    for page in ("256", "512"):
        def s(key: str, page: str = page) -> int:
            return sum(r["spiffs"][page][key] for r in rows)
        files = sum(r["spiffs"][page]["files_per_entry"] for r in rows)
        print(f"ESP32 SPIFFS, {page} B pages (whole set, {len(rows)} scenes)")
        print(f"  one JSON file a scene (today)  {kb(s('json_file')):>12}  {len(rows)} files")
        print(f"  one stored zip a scene         {kb(s('zip_stored_file')):>12}  {len(rows)} files")
        print(f"  one deflated zip a scene       {kb(s('zip_deflated_file')):>12}  {len(rows)} files")
        print(f"  one hybrid zip a scene         {kb(s('zip_hybrid_file')):>12}  {len(rows)} files")
        print(f"  one file an entry, unpacked    {kb(s('file_per_entry')):>12}  {files} files")
    if args.history:
        h = history(args.history)
        (out / "history.json").write_text(json.dumps(h, indent=1))
        print()
        print(f"History: last {h['commits']} commits touching a sample, {h['scene_changes']} scene changes "
              f"({h['graph_only_changes']} touched only scene.json)")
        print(f"  per-scene patch (today)        {kb(h['per_scene_bytes']):>12}  deflated {kb(h['per_scene_deflated'])}")
        print(f"  per-entry patch (package)      {kb(h['per_entry_bytes']):>12}  deflated {kb(h['per_entry_deflated'])}")
    if args.json:
        json.dump(rows, sys.stdout, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
