import pytest

from app.api.apps import api_apps_js_api_reference


@pytest.mark.asyncio
async def test_api_apps_js_api_reference():
    data = await api_apps_js_api_reference()

    assert "markdown" in data
    assert "FrameOS JavaScript App API" in data["markdown"]
    assert "frameos.image" in data["markdown"]
    assert "frameos.setNextSleep" in data["markdown"]
    assert "frameos.assets.writeText" in data["markdown"]
    assert "interface App extends FrameOSApp<Config> {}" in data["markdown"]
    assert "type Output =" in data["markdown"]
    assert "initialized?: boolean" in data["markdown"]
    assert "FrameOSContext" in data["markdown"]
