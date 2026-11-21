"""The layout chosen where a backend frame's card or board is flashed.

docs/scene-layouts.md "Chosen at the flash": the SPA saves the frame's scenes
with the chosen starter installed (a copy of a repository layout sample, its
own id) and worn by every scene, through the frame's ordinary update route,
before the SD card is built or the ESP32 written. These pin the backend half:
the route takes that shape, and what a card and a board are given carries it.
"""

import json
from pathlib import Path

import pytest

from app.models.frame import Frame, new_frame
from app.tasks.buildroot_image import _buildroot_setup_payload, buildroot_sd_image_config_fingerprint

SAMPLES = Path(__file__).resolve().parents[4] / "repo" / "scenes" / "samples"


def _starter_copy(sample: str, copy_id: str, state: dict) -> dict:
    """What the SPA installs: the sample's layout with its own id and the gear's values as its defaults."""
    scene = dict(json.loads((SAMPLES / sample / "scenes.json").read_text())[0])
    scene.pop("default", None)
    scene["id"] = copy_id
    scene["fields"] = [
        {**field, "value": state[field["name"]]} if field.get("name") in state else field
        for field in scene.get("fields") or []
    ]
    return scene


@pytest.mark.asyncio
async def test_a_flashed_layout_is_saved_on_the_frame_and_rides_the_sd_card(async_client, db, redis, monkeypatch):
    frame = await new_frame(db, redis, "Flashed", "localhost", "localhost")
    before = buildroot_sd_image_config_fingerprint(frame)
    layout = _starter_copy("Windows 98 layout", "win98-copy", {"look": "contrast"})
    assert layout["settings"]["isLayout"] is True
    clock = {
        "id": "clock",
        "name": "Clock",
        "nodes": [],
        "edges": [],
        "layout": {"sceneId": "win98-copy", "state": {"look": "contrast"}},
    }

    resp = await async_client.post(f"/api/frames/{frame.id}", json={"scenes": [clock, layout]})
    assert resp.status_code == 200, resp.text

    db.expire_all()
    saved = db.get(Frame, frame.id)
    assert [scene["id"] for scene in saved.scenes] == ["clock", "win98-copy"]
    assert saved.scenes[0]["layout"] == {"sceneId": "win98-copy", "state": {"look": "contrast"}}
    look = next(field for field in saved.scenes[1]["fields"] if field["name"] == "look")
    assert look["value"] == "contrast"

    # The card's setup file carries the scenes as saved, and the image built
    # before the layout was chosen is no longer the one to hand out.
    monkeypatch.setattr("app.tasks.buildroot_image.get_frame_json", lambda _db, _frame: {"id": frame.id})
    payload = _buildroot_setup_payload(None, saved)
    assert payload["scenes"][0]["layout"] == {"sceneId": "win98-copy", "state": {"look": "contrast"}}
    assert buildroot_sd_image_config_fingerprint(saved) != before
