"""docs/scene-package-fixtures.json against app/utils/scene_package.py; the
SPA's frontend/src/utils/scenePackage.ts and the runtime's scene_package.nim
replay the same corpus."""

import copy
import io
import json
import zipfile
from pathlib import Path

import pytest

from app.utils import scene_package as sp

FIXTURES = json.loads((Path(__file__).resolve().parents[4] / "docs" / "scene-package-fixtures.json").read_text())


def _parsed(files: dict[str, str]) -> dict:
    out = {}
    for path, text in files.items():
        parts = path.split("/")
        out[path] = json.loads(text) if parts[-1] in ("scene.json", "template.json") and "apps" not in parts[:-1] else text
    return out


def _texts(files: dict) -> dict[str, str]:
    return {path: value if isinstance(value, str) else json.dumps(value) for path, value in files.items()}


@pytest.mark.parametrize("case", FIXTURES["scenes"], ids=lambda case: case["name"])
def test_scene_package(case):
    files = sp.scene_package_files(copy.deepcopy(case["scene"]), without_tests=case.get("withoutTests", False))
    assert _parsed(files) == case["files"]
    assert list(files)[0] == sp.SCENE_FILE
    if not case.get("withoutTests"):
        assert sp.scene_from_package_files(_texts(case["files"])) == case["scene"]


@pytest.mark.parametrize("case", FIXTURES["sets"], ids=lambda case: case["name"])
def test_set_package(case):
    files = sp.set_package_files(copy.deepcopy(case["scenes"]), case["manifest"])
    assert _parsed(files) == case["files"]
    scenes, manifest = sp.set_from_package_files(_texts(case["files"]))
    assert scenes == case["scenes"]
    assert manifest == case["files"]["template.json"]


@pytest.mark.parametrize("case", FIXTURES["folderNames"], ids=lambda case: ",".join(case["folders"]))
def test_folder_names(case):
    assert sp.scene_folder_names(case["scenes"]) == case["folders"]


@pytest.mark.parametrize("case", FIXTURES["reads"], ids=lambda case: case["name"])
def test_reads(case):
    scenes, manifest = sp.set_from_package_files(case["files"])
    assert scenes == case["scenes"]
    assert manifest == case["manifest"]


@pytest.mark.parametrize("case", FIXTURES["refusals"], ids=lambda case: case["name"])
def test_refusals(case):
    with pytest.raises(sp.ScenePackageError) as error:
        sp.set_from_package_files(case["files"])
    assert error.value.code == case["code"]


def test_device_package_keeps_scene_json_first_and_stored():
    scene = FIXTURES["scenes"][0]["scene"]
    data = sp.device_package_bytes(copy.deepcopy(scene))
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        infos = zf.infolist()
        assert infos[0].filename == sp.SCENE_FILE
        assert infos[0].compress_type == zipfile.ZIP_STORED
        assert all(info.compress_type == zipfile.ZIP_DEFLATED for info in infos[1:])
        assert not any(sp.is_app_test_file(info.filename) for info in infos)
    # scene.json is readable straight after its local header (30 bytes and the name).
    name_len = int.from_bytes(data[26:28], "little")
    extra_len = int.from_bytes(data[28:30], "little")
    size = int.from_bytes(data[18:22], "little")
    start = 30 + name_len + extra_len
    assert json.loads(data[start : start + size])["id"] == scene["id"]


def test_a_scene_saved_back_from_a_frame_keeps_the_planes_app_tests():
    """A frame is never sent an app's tests (retired_apps.scenes_for_frame):
    its code editor saves a scene without them, and the plane keeps its own."""
    stored = {"id": "s", "apps": {"a": {"sources": {"app.ts": "old", "app.test.ts": "t", "lib.test.ts": "u"}}, "gone": {"sources": {"x.test.ts": "v"}}}}
    saved = {"id": "s", "apps": {"a": {"name": "A", "sources": {"app.ts": "new", "lib.test.ts": "mine"}}, "b": {"sources": {"app.ts": "b"}}}}
    kept = sp.keep_app_test_files(saved, stored)
    assert kept["apps"]["a"]["sources"] == {"app.ts": "new", "lib.test.ts": "mine", "app.test.ts": "t"}
    assert kept["apps"]["b"] == {"sources": {"app.ts": "b"}}
    assert "gone" not in kept["apps"]
    assert sp.keep_app_test_files(saved, None) is saved
