"""The scene-execution conformance corpus (docs/scene-execution-fixtures.json).

The same JSON drives the frontend's and the cloud's runners
(cloud/apps/auth-web/src/test/shared-spa/scene-execution-fixtures.test.ts), so
a rule that drifts on one plane fails a test instead of shipping a scene that
one control plane compiles and the other refuses.
"""
from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.codegen.drivers_nim import frame_compilation_mode
from app.utils.scene_execution import scene_execution, scene_requires_compilation

FIXTURES = Path(__file__).resolve().parents[4] / "docs" / "scene-execution-fixtures.json"
CORPUS = json.loads(FIXTURES.read_text(encoding="utf-8"))


def test_corpus_is_not_empty():
    assert len(CORPUS["scenes"]) >= 15
    assert len(CORPUS["frames"]) >= 8


@pytest.mark.parametrize("case", CORPUS["scenes"], ids=lambda case: case["name"])
def test_scene_rule(case):
    scene = case["scene"]
    assert scene_requires_compilation(scene) is case["requiresCompilation"]
    assert scene_execution(scene) == case["execution"]
    # What the cloud store refuses: an explicit compiled stamp or Nim the
    # interpreter cannot run (compiledSceneNames in cloud/apps/auth-web).
    cloud_refuses = scene_execution(scene) == "compiled" or scene_requires_compilation(scene)
    assert cloud_refuses is case["cloudRefuses"]


@pytest.mark.parametrize("case", CORPUS["frames"], ids=lambda case: case["name"])
def test_frame_compilation_mode(case):
    frame = SimpleNamespace(
        mode=case["frame"].get("mode"),
        rpios=case["frame"].get("rpios"),
        buildroot=case["frame"].get("buildroot"),
    )
    assert frame_compilation_mode(frame) == case["compilationMode"]
