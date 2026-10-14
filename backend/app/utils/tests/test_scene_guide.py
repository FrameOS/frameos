import re
import subprocess
from pathlib import Path

from app.utils.ai_app import APP_EDIT_SYSTEM_PROMPT
from app.utils.ai_scene import SCENE_JSON_SYSTEM_PROMPT
from app.utils.repo_apps import bundle_repo_apps, repo_app_configs, repo_app_sources
from app.utils.scene_guide_gen import SCENE_GUIDE, SCENE_GUIDE_SECTIONS

REPO_ROOT = Path(__file__).resolve().parents[4]


def test_generated_copies_are_current():
    """docs/scene-guide.md is copied into the backend and the cloud, with the
    events and the JS API filled in; the generator also refuses when the
    runtime's frameos object and the editor's declarations disagree."""
    generator = REPO_ROOT / "frameos" / "tools" / "generate_scene_guide.py"
    result = subprocess.run(["python3", str(generator), "--check"], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_guide_sections():
    ids = [section["id"] for section in SCENE_GUIDE_SECTIONS]
    assert len(ids) == len(set(ids))
    assert {"nodes", "edges", "code-nodes", "js-apps", "events", "js-api-reference"} <= set(ids)
    for section in SCENE_GUIDE_SECTIONS:
        assert section["text"] in SCENE_GUIDE
    # The cloud's scene AI never mentions the runtime's implementation language.
    assert not re.search(r"\bnim\b", SCENE_GUIDE, re.I)
    assert "<!--" not in SCENE_GUIDE
    assert "frameos.remember" in SCENE_GUIDE and "declare const frameos" in SCENE_GUIDE


def test_prompts_carry_the_guide():
    assert SCENE_GUIDE.strip() in SCENE_JSON_SYSTEM_PROMPT
    js_apps = next(section["text"] for section in SCENE_GUIDE_SECTIONS if section["id"] == "js-apps")
    assert js_apps in APP_EDIT_SYSTEM_PROMPT
    assert "data/openaiImage" not in SCENE_JSON_SYSTEM_PROMPT


def test_repo_app_templates():
    configs = repo_app_configs()
    assert "repo/apps/image/googlePhotos" in configs and "repo/apps/image/chart" in configs
    assert not any(keyword.startswith("repo/apps/code/") for keyword in configs)
    sources = repo_app_sources("repo/apps/image/googlePhotos")
    assert "config.json" in sources and "app.ts" in sources
    # A keyword from before the folders were named for what the apps return.
    assert repo_app_sources("repo/apps/code/googlePhotos") == sources
    assert repo_app_sources("repo/apps/image/../googlePhotos") == {}
    assert repo_app_sources("repo/apps/image/nope") == {}


def test_bundle_repo_apps():
    payload = {
        "scenes": [
            {
                "id": "s",
                "nodes": [
                    {"id": "a", "type": "app", "data": {"keyword": "repo/apps/image/googlePhotos", "config": {}}},
                    {"id": "b", "type": "app", "data": {"keyword": "repo/apps/code/googlePhotos", "config": {}}},
                    {"id": "c", "type": "app", "data": {"keyword": "render/image", "config": {}}},
                    {"id": "d", "type": "app", "data": {"keyword": "repo/apps/image/nope", "config": {}}},
                ],
                "edges": [],
            }
        ]
    }
    bundled = bundle_repo_apps(payload)
    scene = payload["scenes"][0]
    assert bundled == [
        "repo/apps/image/googlePhotos -> apps.googlePhotos",
        "repo/apps/code/googlePhotos -> apps.googlePhotos",
    ]
    assert [node["data"]["keyword"] for node in scene["nodes"]] == ["googlePhotos", "googlePhotos", "render/image", "repo/apps/image/nope"]
    app = scene["apps"]["googlePhotos"]
    assert app["origin"] == "repo/apps/image/googlePhotos"
    assert app["name"] == repo_app_configs()["repo/apps/image/googlePhotos"]["name"]
    assert "app.ts" in app["sources"]
