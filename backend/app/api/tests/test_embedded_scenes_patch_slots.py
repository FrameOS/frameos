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


@pytest.mark.asyncio
@pytest.mark.parametrize("changed", [1, 24])
async def test_after_a_save_and_a_deploy_the_next_pull_is_a_304(async_client, no_auth_client, db, redis, changed):
    """Save, fast deploy, pull, pull again with the first answer's ETag: a
    304, whether the first answer was a patch (one scene changed) or the
    whole list (24 changed, past the slots). The SenseCAP's second 200 after
    a push (2026-11-15) carried the same ETag as the first: the device asked
    without it (a deploy's forced sync and the link task's poll both
    fetching, fos_scenes_backend_fetch), not a backend whose ETag moved."""
    from unittest.mock import AsyncMock, patch

    frame = await device_frame(async_client, db)
    # Saved as the editor saves (which stamps each scene's settings).
    response = await async_client.post(f"/api/frames/{frame.id}", json={"scenes": scenes(25)})
    assert response.status_code == 200, response.text
    url = f"/api/frames/{frame.id}/embedded/scenes?patch=1"
    held = (await no_auth_client.get(url, headers=auth(frame))).headers["etag"]

    saved = [*scenes(25)[: 25 - changed], *scenes(25, " laid out")[25 - changed :]]
    response = await async_client.post(f"/api/frames/{frame.id}", json={"scenes": saved})
    assert response.status_code == 200, response.text
    with patch("app.tasks.fast_deploy_frame", new_callable=AsyncMock) as fast_deploy:
        response = await async_client.post(f"/api/frames/{frame.id}/fast_deploy")
    assert response.status_code == 200, response.text
    fast_deploy.assert_awaited_once()

    first = await no_auth_client.get(url, headers={**auth(frame), "If-None-Match": held})
    assert first.status_code == 200
    body = first.json()
    if changed == 24:
        assert isinstance(body, list) and len(body) == 25
    else:
        assert body["patch"] is True and len(body["put"]) == 1
    etag = first.headers["etag"]
    assert etag != held

    for _ in range(2):
        again = await no_auth_client.get(url, headers={**auth(frame), "If-None-Match": etag})
        assert again.status_code == 304
        assert again.headers["etag"] == etag
    # One that names nothing gets the same set under the same ETag.
    bare = await no_auth_client.get(url, headers=auth(frame))
    assert bare.status_code == 200 and bare.headers["etag"] == etag
