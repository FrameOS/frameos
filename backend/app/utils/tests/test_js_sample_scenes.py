"""The bundled pure JS sample scenes (repo/scenes/samples/JS *).

Each sample is authored as files (scene.json + scene.ts and what it imports)
and packed into the scenes.json the frame reads by
frameos/tools/pack_js_scenes.py; this keeps the two in step and checks the
packed scenes are what every control plane expects of a js scene.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from app.utils.scene_execution import scene_execution, scene_is_js, scene_runs_from_json

ROOT = Path(__file__).resolve().parents[4]
SAMPLES = ROOT / "repo" / "scenes" / "samples"
PACKER = ROOT / "frameos" / "tools" / "pack_js_scenes.py"
JS_SAMPLES = sorted(path.parent for path in SAMPLES.glob("*/scene.json"))


def test_there_are_js_samples():
    assert len(JS_SAMPLES) >= 5


def test_packed_scenes_json_is_current():
    result = subprocess.run([sys.executable, "-I", str(PACKER), "--check"], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("sample", JS_SAMPLES, ids=lambda path: path.name)
def test_sample_is_a_well_formed_js_scene(sample: Path):
    scenes = json.loads((sample / "scenes.json").read_text(encoding="utf-8"))
    assert isinstance(scenes, list) and len(scenes) == 1
    scene = scenes[0]
    assert scene_execution(scene) == "js"
    assert scene_is_js(scene) and scene_runs_from_json(scene)
    assert scene["nodes"] == [] and scene["edges"] == []
    assert "scene.ts" in scene["sources"]
    assert "export function render" in scene["sources"]["scene.ts"]
    # The files on disk are the files in the JSON.
    for name, content in scene["sources"].items():
        assert (sample / name).read_text(encoding="utf-8") == content
    template = json.loads((sample / "template.json").read_text(encoding="utf-8"))
    assert template["scenes"] == "./scenes.json"
    for field in scene.get("fields", []):
        assert field["access"] in {"public", "private"}
