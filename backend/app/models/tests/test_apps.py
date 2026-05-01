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
    assert configs["repo/examples/jsText"]["source"] == "repo/examples/jsText"

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
async def test_get_one_ts_app_sources():
    sources = get_one_app_sources("repo/examples/jsText")
    assert "app.ts" in sources
    assert "config.json" in sources
    assert "app.js" not in sources
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
                    "id": "node-js",
                    "type": "app",
                    "data": {"sources": {"app.ts": "export function get() { return 'ok' }"}}
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
    assert "node-js" not in apps


@pytest.mark.asyncio
async def test_get_scene_apps_from_scenes():
    sources = {"config.json": '{"name":"Scene Nim"}', "app.nim": "nim code"}
    scenes = [{"apps": {"repo/examples/nimText": {"sources": sources}}, "nodes": []}]
    apps = get_scene_apps_from_scenes(scenes)
    assert apps[get_scene_app_id("repo/examples/nimText", sources)] == sources


@pytest.mark.asyncio
async def test_get_scene_apps_from_scenes_skips_js_sources():
    sources = {"config.json": '{"name":"Scene JS"}', "app.ts": "export function get(): string { return 'ok' }"}
    scenes = [{"apps": {"repo/examples/jsText": {"sources": sources}}, "nodes": []}]
    apps = get_scene_apps_from_scenes(scenes)
    assert apps == {}


@pytest.mark.asyncio
async def test_get_scene_apps_from_scenes_keeps_same_keyword_sources_separate():
    first_sources = {"config.json": '{"name":"Scene Nim"}', "app.nim": "one"}
    second_sources = {"config.json": '{"name":"Scene Nim"}', "app.nim": "two"}
    scenes = [
        {"apps": {"repo/examples/nimText": {"sources": first_sources}}, "nodes": []},
        {"apps": {"repo/examples/nimText": {"sources": second_sources}}, "nodes": []},
    ]

    apps = get_scene_apps_from_scenes(scenes)

    assert len(apps) == 2
    assert apps[get_scene_app_id("repo/examples/nimText", first_sources)] == first_sources
    assert apps[get_scene_app_id("repo/examples/nimText", second_sources)] == second_sources
