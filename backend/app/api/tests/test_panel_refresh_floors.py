"""A board rendered on the server is never told to pull again sooner than its
panel can refresh (docs/panel-refresh-floors.json, docs/server-rendering.md
"When the next picture is due")."""

import json
import re
from pathlib import Path

import pytest

from app.api.embedded_device import (
    NEXT_RENDER_MIN_SECONDS,
    PANEL_REFRESH_FLOOR_SECONDS,
    held_to_panel_floor,
)

from .test_embedded_device import auth, pico_spectra_frame
from .test_server_rendering import SCENES, recording_renderer

CONTRACT = json.loads(
    (Path(__file__).resolve().parents[4] / "docs" / "panel-refresh-floors.json").read_text()
)


def test_the_table_is_the_contracts():
    assert PANEL_REFRESH_FLOOR_SECONDS == {
        int(fmt): entry["seconds"] for fmt, entry in CONTRACT["floors"].items()
    }


def test_the_clouds_copy_is_the_contracts():
    """Read here too: this suite runs on every pull request, the cloud's only
    on those that touch cloud/."""
    source = (Path(__file__).resolve().parents[4] / "cloud/apps/auth-web/src/lib/server-render.ts").read_text()
    table = re.search(r"export const panelRefreshFloorSeconds[^=]*= \{([^}]*)\}", source)
    assert table
    cloud = {int(fmt): int(seconds) for fmt, seconds in re.findall(r"(\d+):\s*(\d+)", table.group(1))}
    assert cloud == PANEL_REFRESH_FLOOR_SECONDS


@pytest.mark.parametrize("case", CONTRACT["cases"], ids=lambda case: case["name"])
def test_the_contracts_cases(case):
    wanted = case["wanted"]
    # The plane's own floor first (next_render_seconds), then the panel's.
    planed = None if wanted is None else max(wanted, case["planeFloor"])
    assert held_to_panel_floor(planed, case["pixelFormat"]) == case["seconds"]


@pytest.mark.asyncio
async def test_an_inky_frame_spectra_is_not_told_ten_seconds(async_client, no_auth_client, db, redis, monkeypatch):
    """The Pimoroni Inky Frame 7.3" Spectra on a 10 s clock scene: told the
    Spectra 6 floor, on the picture and on the 304 for it."""
    frame = await pico_spectra_frame(async_client, db)
    frame.scenes = SCENES
    db.add(frame)
    db.commit()
    await redis.set(f"frame:{frame.id}:active_scene", "clock")
    monkeypatch.setattr(
        "app.api.embedded_device.render_scene_rgba_and_state",
        recording_renderer([], state={"sceneId": "clock", "state": {}, "nextSleep": -1, "refreshInterval": 10}),
    )
    url = f"/api/frames/{frame.id}/embedded/render"
    first = await no_auth_client.get(url, headers=auth(frame))
    assert first.status_code == 200, first.text
    assert NEXT_RENDER_MIN_SECONDS < 60
    assert first.headers["x-frameos-next-render"] == "60"
    same = await no_auth_client.get(url, headers={**auth(frame), "If-None-Match": first.headers["etag"]})
    assert same.status_code == 304
    assert same.headers["x-frameos-next-render"] == "60"
