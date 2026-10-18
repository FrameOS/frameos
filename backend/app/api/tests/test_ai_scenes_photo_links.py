"""The scene AI never sends a Photos share link to OpenAI: the prompt, the
history, the scene and the selection carry placeholders, and the scenes the
model returns get the real link back (app/utils/photo_share_links.py)."""

import json

import pytest

from app.api import ai_scenes
from app.models import new_frame
from app.models.settings import Settings

TOKEN = "pk_" + "k3J5h7G9" * 4
LINK = f"/api/photos/shared/{TOKEN}"
PLACEHOLDER_LINK = "/api/photos/shared/pk_photo_link_1"


def album_scene(album: str) -> dict:
    return {
        "id": "album-scene",
        "name": "Summer",
        "nodes": [{"id": "n1", "type": "app", "data": {"keyword": "photoAlbum", "config": {"album": album}}}],
        "edges": [],
        "settings": {"refreshInterval": 3600},
    }


async def _setup(db, redis, monkeypatch):
    frame = await new_frame(db, redis, "AlbumFrame", "frame.local", "backend.local")
    db.add(Settings(project_id=frame.project_id, key="openAI", value={"backendApiKey": "sk-test"}))
    db.commit()

    async def catalog(**_kwargs):
        return "", []

    monkeypatch.setattr(ai_scenes, "_load_catalog_context", catalog)
    monkeypatch.setattr(ai_scenes, "bundle_repo_apps", lambda payload: None)
    monkeypatch.setattr(ai_scenes, "validate_scene_payload", lambda payload: [])
    return frame


@pytest.mark.asyncio
async def test_modify_scene_sees_placeholders_and_returns_the_link(async_client, db, redis, monkeypatch):
    frame = await _setup(db, redis, monkeypatch)
    seen: dict = {}

    async def route(**kwargs):
        seen["route"] = kwargs
        return {"tool": "modify_scene", "tool_prompt": kwargs["prompt"]}

    async def modify(**kwargs):
        seen["modify"] = kwargs
        scene = json.loads(json.dumps(kwargs["scene"]))
        scene["nodes"][0]["data"]["config"]["fit"] = "contain"
        return {"scenes": [scene]}

    monkeypatch.setattr(ai_scenes, "route_scene_chat", route)
    monkeypatch.setattr(ai_scenes, "modify_scene_json", modify)

    response = await async_client.post(
        f"/api/projects/{frame.project_id}/ai/scenes/chat",
        json={
            "prompt": f"Fit the photos from {LINK} inside the screen",
            "frameId": frame.id,
            "sceneId": "album-scene",
            "scene": album_scene(LINK),
            "selectedNodes": album_scene(LINK)["nodes"],
            "history": [{"role": "user", "content": f"Play {LINK}"}],
        },
    )
    assert response.status_code == 200, response.text

    # Nothing that reached a model call holds the token.
    sent = json.dumps({key: {k: v for k, v in call.items() if k != "api_key"} for key, call in seen.items()}, default=str)
    assert TOKEN not in sent
    assert PLACEHOLDER_LINK in sent
    assert seen["modify"]["scene"]["nodes"][0]["data"]["config"]["album"] == PLACEHOLDER_LINK

    # The scene the editor gets back plays the real album.
    scene = response.json()["scenes"][0]
    assert scene["nodes"][0]["data"]["config"] == {"album": LINK, "fit": "contain"}
    # The prompt the scene records is the user's, link included.
    assert scene["settings"]["prompt"] == f"Fit the photos from {LINK} inside the screen"
