#!/usr/bin/env python3
"""Render the shipped scene corpus through the WASM runtime with the planner
on and off, and compare the pixels.

The host-side corpus differential (test_repo_scenes_differential.nim) proves
principle 4 over the native interpreter; this proves it over the emscripten
build the browser live-preview and the thin-client render path actually run —
same scenes, same A/B, different runtime.

Usage:
  tools/wasm_differential.py [--wasm-dir DIR]

DIR defaults to ../frontend/public/frameos-wasm; build it first with
tools/build_wasm.sh (needs emscripten). Scenes that disagree with themselves
across two materialized renders (clocks, random pickers) are skipped by name,
never silently.
"""
import argparse
import json
import pathlib
import subprocess
import sys

FRAMEOS_DIR = pathlib.Path(__file__).resolve().parent.parent
REPO_ROOT = FRAMEOS_DIR.parent
SAMPLES = REPO_ROOT / "repo" / "scenes" / "samples"
RENDER_MJS = REPO_ROOT / "backend" / "tools" / "embedded_wasm_render.mjs"

# Mirrors test_repo_scenes_differential.nim: downloadUrl stays in because every
# sample but XKCD leaves its url empty, which fails fast and deterministically.
NETWORK_APPS = {
    "downloadImage", "wikicommons", "frameOSGallery", "weather", "beRecycle",
    "unsplash", "immich", "googlePhotos", "openaiImage", "haSensor",
}
HOST_ONLY_APPS = {"chromiumScreenshot", "rstpSnapshot"}

WIDTH, HEIGHT = 800, 480


def scene_apps(scene, scenes_by_id, visited=None):
    visited = visited if visited is not None else set()
    if scene.get("id") in visited:
        return set()
    visited.add(scene.get("id"))
    apps = set()
    for node in scene.get("nodes", []):
        keyword = (node.get("data") or {}).get("keyword") or ""
        if not keyword:
            continue
        if node.get("type") == "app" or node.get("nodeType") == "app":
            apps.add(keyword.rsplit("/", 1)[-1])
        elif node.get("type") == "scene" or node.get("nodeType") == "scene":
            child = scenes_by_id.get(keyword)
            if child is not None:
                apps |= scene_apps(child, scenes_by_id, visited)
    return apps


def render(wasm_dir, scenes_json, scene_id, disable_fusion):
    request = {
        "assetsDir": str(wasm_dir),
        "width": WIDTH,
        "height": HEIGHT,
        "scenesJson": scenes_json,
        "sceneId": scene_id,
        "disableFusion": disable_fusion,
    }
    proc = subprocess.run(
        ["node", str(RENDER_MJS)],
        input=json.dumps(request).encode(),
        capture_output=True,
    )
    if proc.returncode != 0 or len(proc.stdout) != WIDTH * HEIGHT * 4:
        raise RuntimeError(
            f"render failed (rc={proc.returncode}, {len(proc.stdout)} bytes): "
            + proc.stderr.decode("utf-8", "replace")[-500:]
        )
    return proc.stdout


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--wasm-dir",
        default=str(REPO_ROOT / "frontend" / "public" / "frameos-wasm"))
    args = parser.parse_args()
    wasm_dir = pathlib.Path(args.wasm_dir)
    if not (wasm_dir / "frameos.wasm").exists():
        sys.exit(f"no frameos.wasm in {wasm_dir}; run tools/build_wasm.sh first")

    compared, skipped, failures = [], [], []
    for template_dir in sorted(SAMPLES.iterdir()):
        scenes_path = template_dir / "scenes.json"
        if not scenes_path.exists():
            continue
        scenes_json = scenes_path.read_text()
        data = json.loads(scenes_json)
        scenes = data if isinstance(data, list) else data.get("scenes", [data])
        by_id = {s.get("id"): s for s in scenes}
        for scene in scenes:
            label = f"{template_dir.name} / {scene.get('name')}"
            apps = scene_apps(scene, by_id)
            if apps & (NETWORK_APPS | HOST_ONLY_APPS):
                continue
            try:
                a1 = render(wasm_dir, scenes_json, scene["id"], True)
                a2 = render(wasm_dir, scenes_json, scene["id"], True)
            except RuntimeError as error:
                failures.append(f"{label}: materialized render failed: {error}")
                continue
            if a1 != a2:
                skipped.append(label)
                continue
            try:
                fused = render(wasm_dir, scenes_json, scene["id"], False)
            except RuntimeError as error:
                failures.append(f"{label}: fused render failed: {error}")
                continue
            if fused != a1:
                diff = sum(1 for x, y in zip(fused, a1) if x != y)
                failures.append(f"{label}: fused differs in {diff} of {len(a1)} bytes")
            else:
                compared.append(label)

    print(f"wasm differential: {len(compared)} scenes byte-identical fused vs "
          f"materialized, {len(skipped)} nondeterministic skipped "
          f"({', '.join(skipped) or 'none'})")
    for failure in failures:
        print("FAIL:", failure)
    if failures:
        sys.exit(1)
    if len(compared) < 5:
        sys.exit(f"only {len(compared)} scenes compared — corpus went missing?")


if __name__ == "__main__":
    main()
