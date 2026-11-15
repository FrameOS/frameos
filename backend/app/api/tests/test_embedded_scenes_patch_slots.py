"""A scenes patch the ESP32's scene store could not fit is not sent: the
whole list goes up front (embedded/esp32/README.md "Scene storage").

A patch is one change in fos_scene_store.c: each put goes to a new slot while
every scene the board holds keeps its own until the index switches. 25 scenes
held and 24 changed need 49 of the 32 slots; the board answered
`no free scene slot` and asked for the whole list anyway."""

import re
from pathlib import Path

import pytest

from app.api.embedded_device import ESP32_SCENE_STORE_SLOTS

from .test_embedded_device import auth, device_frame

ROOT = Path(__file__).resolve().parents[4]


def test_the_slot_count_is_the_firmwares_and_the_clouds():
    header = (ROOT / "embedded/esp32/main/fos_scene_store.h").read_text()
    firmware = re.search(r"#define\s+FOS_SCENE_STORE_SLOTS\s+(\d+)", header)
    assert firmware and int(firmware.group(1)) == ESP32_SCENE_STORE_SLOTS
    cloud = (ROOT / "cloud/apps/auth-web/src/lib/scenes-patch.ts").read_text()
    mirrored = re.search(r"export const esp32SceneStoreSlots = (\d+);", cloud)
    assert mirrored and int(mirrored.group(1)) == ESP32_SCENE_STORE_SLOTS


def scenes(count: int, name: str = "") -> list[dict]:
    return [{"id": f"s{i}", "name": f"S{i}{name}", "nodes": [], "edges": []} for i in range(count)]


@pytest.mark.asyncio
async def test_a_patch_that_does_not_fit_the_slots_is_the_whole_list(async_client, no_auth_client, db, redis):
    frame = await device_frame(async_client, db)
    frame.scenes = scenes(25)
    db.commit()
    url = f"/api/frames/{frame.id}/embedded/scenes?patch=1"
    first = await no_auth_client.get(url, headers=auth(frame))
    assert isinstance(first.json(), list)
    etag = first.headers["etag"]

    # Every scene but one given a layout: 25 held + 24 put > 32.
    held = [scenes(25)[0], *scenes(25, " laid out")[1:]]
    frame.scenes = held
    db.commit()
    whole = await no_auth_client.get(url, headers={**auth(frame), "If-None-Match": etag})
    assert whole.status_code == 200
    assert isinstance(whole.json(), list) and len(whole.json()) == 25

    # 25 held + 7 put = 32: that still fits, and is a patch.
    etag = whole.headers["etag"]
    frame.scenes = [*held[:18], *scenes(25, " again")[18:]]
    db.commit()
    patch = await no_auth_client.get(url, headers={**auth(frame), "If-None-Match": etag})
    body = patch.json()
    assert body["patch"] is True
    assert len(body["put"]) == 7
    assert len(body["order"]) == 25
