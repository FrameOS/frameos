import pytest
from app.models.apps import (
    get_app_configs,
    get_local_frame_apps,
    get_one_app_sources,
    get_apps_from_scenes,
    get_scene_app_id,
    get_scene_apps_from_scenes,
)

@pytest.mark.asyncio
async def test_get_app_configs():
    configs = get_app_configs()
    assert isinstance(configs, dict)
    assert configs["repo/jsExamples/jsText"]["source"] == "repo/jsExamples/jsText"

@pytest.mark.asyncio
async def test_get_local_frame_apps():
    apps = get_local_frame_apps()
    assert len(apps) > 0

@pytest.mark.asyncio
async def test_get_one_app_sources():
    sources = get_one_app_sources("logic/ifElse")
    assert "app.nim" in sources
    assert "config.json" in sources

@pytest.mark.asyncio
async def test_get_one_js_app_sources():
    sources = get_one_app_sources("repo/jsExamples/jsText")
    assert "app.js" in sources
    assert "config.json" in sources
    assert "app.nim" not in sources
    assert "app_loader.nim" not in sources

@pytest.mark.asyncio
async def test_get_apps_from_scenes():
    scenes = [
        {
            "nodes": [
                {
                    "id": "node1",
                    "type": "app",
                    "data": {"sources": {"app.nim": "nim code"}}
                },
                {
                    "id": "node2",
                    "type": "some_other_type"
                }
            ]
        }
    ]
    apps = get_apps_from_scenes(scenes)
    assert len(apps) == 1
    assert "node1" in apps


@pytest.mark.asyncio
async def test_get_scene_apps_from_scenes():
    sources = {"config.json": '{"name":"Scene JS"}', "app.js": "export function get() { return 'ok' }"}
    scenes = [{"apps": {"repo/jsExamples/jsText": {"sources": sources}}, "nodes": []}]
    apps = get_scene_apps_from_scenes(scenes)
    assert apps[get_scene_app_id("repo/jsExamples/jsText")] == sources
