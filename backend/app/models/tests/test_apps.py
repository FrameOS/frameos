import pytest
from app.models.apps import (
    get_app_configs,
    get_local_frame_apps,
    get_one_app_sources,
    get_apps_from_scenes
)

@pytest.mark.asyncio
async def test_get_app_configs():
    configs = get_app_configs()
    assert isinstance(configs, dict)

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
