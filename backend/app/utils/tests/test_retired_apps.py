import copy
import json

import pytest

from app.utils.retired_apps import (
    REPO_ROOT,
    RETIRED_APPS,
    keywords_runtime_lacks,
    replacement_app_entry,
    retired_app_config,
    restore_apps_in_scenes,
    retire_apps_in_scenes,
    scenes_for_runtime,
)

CONTRACT = json.loads((REPO_ROOT / "docs" / "retired-apps.json").read_text())
FIXTURES = json.loads((REPO_ROOT / "docs" / "retired-apps-fixtures.json").read_text())


def expand(value):
    """Swap the fixtures' "@repo/apps/<folder>/<app>" placeholders for the real entry."""
    if isinstance(value, str) and value.startswith("@repo/"):
        return replacement_app_entry(value[1:])
    if isinstance(value, list):
        return [expand(item) for item in value]
    if isinstance(value, dict):
        return {key: expand(item) for key, item in value.items()}
    return value


def test_table_is_the_contract():
    assert RETIRED_APPS == CONTRACT["apps"]


def test_generated_copies_are_current():
    """The cloud and the Linux runtime carry generated copies of the table and
    of each replacement app; a change to either needs the generator run."""
    import subprocess

    generator = REPO_ROOT / "frameos" / "tools" / "generate_retired_apps.py"
    result = subprocess.run(["python3", str(generator), "--check"], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("case", FIXTURES["cases"], ids=[case["name"] for case in FIXTURES["cases"]])
def test_fixture(case):
    scenes = expand(case["input"])
    original = copy.deepcopy(scenes)
    if case["op"] == "retire":
        retire_apps_in_scenes(scenes)
        result = scenes
    elif case["op"] == "restore":
        restore_apps_in_scenes(scenes)
        result = scenes
    else:
        result = scenes_for_runtime(scenes, case["runtimeVersion"])
        # A copy for the device: what is stored is never touched.
        assert scenes == original
    assert result == expand(case["output"])


def test_retire_then_restore_is_the_original_scene():
    scenes = [{"id": "s", "nodes": [{"id": "a", "type": "app", "data": {"keyword": "data/immich", "config": {"mode": "album"}}}]}]
    original = copy.deepcopy(scenes)
    assert retire_apps_in_scenes(scenes)
    assert restore_apps_in_scenes(scenes)
    assert scenes == original


def test_replacement_entry_is_the_repo_app():
    entry = replacement_app_entry("repo/apps/image/immich")
    assert entry["origin"] == "repo/apps/image/immich"
    assert entry["settings"] == ["immich"]
    assert entry["sources"]["app.ts"] == (REPO_ROOT / "repo/apps/image/immich/app.ts").read_text()
    assert json.loads(entry["sources"]["config.json"])["name"] == entry["name"]


def test_keywords_runtime_lacks():
    assert keywords_runtime_lacks("2026.10.10") == ["data/immich", "data/frameOSGallery", "data/unsplash", "data/wikicommons", "data/googlePhotos", "data/openaiImage", "data/openaiText", "data/haSensor", "data/weather", "data/beRecycle", "render/chart"]
    # 2026.10.11 has fetchImage; 2026.10.13 has app.frame.embedded,
    # frameos.remember and the failing throw the later four need.
    assert keywords_runtime_lacks("2026.10.11") == ["data/frameOSGallery", "data/unsplash", "data/wikicommons", "data/googlePhotos", "data/openaiImage", "data/beRecycle", "render/chart"]
    assert keywords_runtime_lacks("2026.10.12") == ["data/frameOSGallery", "data/unsplash", "data/wikicommons", "data/googlePhotos", "data/openaiImage", "data/beRecycle", "render/chart"]
    assert keywords_runtime_lacks("2026.10.13") == []
    assert keywords_runtime_lacks(None) == []
    assert keywords_runtime_lacks("not a version") == []


def test_retired_app_config_is_the_replacements_config():
    """What a keyword lookup (the settings walk) reads for a scene that still
    names a retired keyword: the JS replacement's declarations."""
    config = retired_app_config("data/unsplash")
    assert config is not None
    assert config["settings"] == ["unsplash"]
    assert "sources" not in config and "origin" not in config
    assert retired_app_config("data/frameOSGallery").get("settings") is None
    assert retired_app_config("data/clock") is None
    assert retired_app_config(None) is None
