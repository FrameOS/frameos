"""`POST /api/mcp`: the JSON-RPC surface, the tool catalogue's confirm
gate, and a few tools end to end against the real routes (in-process)."""
import base64
import json

import pytest
from sqlalchemy.orm import Session

from app.mcp.protocol import match_uri_template
from app.mcp.registry import SchemaError, validate_value
from app.mcp.tools.frames import duplicate_scenes
from app.models import new_frame
from app.models.frame import Frame

# Every tool that changes what a physical frame does, shows or stores, or
# removes something, takes `confirm`. Adding one means adding it here too.
GATED_TOOLS = {
    "api_token_revoke",
    "frame_asset_delete",
    "frame_asset_mkdir",
    "frame_asset_rename",
    "frame_asset_upload",
    "frame_assets_sync_fonts",
    "frame_delete",
    "frame_deploy",
    "frame_event",
    "frame_firmware_update",
    "frame_reboot",
    "frame_render",
    "frame_restart",
    "frame_scene_activate",
    "frame_scene_install",
    "frame_scene_remove",
    "frame_scene_state_set",
    "frame_scene_update",
    "frame_stop",
    "frame_update",
    "scene_delete",
}


def frame_row(db: Session, frame_id: int) -> Frame:
    db.expire_all()
    frame = db.get(Frame, frame_id)
    assert frame is not None
    return frame


async def rpc(client, method, params=None, request_id=1, headers=None):
    body = {"jsonrpc": "2.0", "id": request_id, "method": method}
    if params is not None:
        body["params"] = params
    return await client.post("/api/mcp", json=body, headers=headers or {})


async def call(client, name, arguments=None, headers=None):
    response = await rpc(client, "tools/call", {"name": name, "arguments": arguments or {}}, headers=headers)
    assert response.status_code == 200, response.text
    payload = response.json()
    assert "error" not in payload, payload
    return payload["result"]


def result_text(result) -> str:
    return "\n".join(item["text"] for item in result["content"] if item["type"] == "text")


def result_json(result):
    return json.loads(result_text(result))


async def mint_token(client, access="full"):
    response = await client.post(
        "/api/user/api_tokens", json={"name": "agent", "access": access, "current_password": "testpassword"}
    )
    assert response.status_code == 201, response.text
    return {"Authorization": f"Bearer {response.json()['token']}"}


SCENE = {
    "id": "scene-a",
    "name": "Hello",
    "nodes": [
        {"id": "n1", "type": "app", "data": {"keyword": "render/text", "config": {"text": "hi"}}, "position": {"x": 0, "y": 0}},
    ],
    "edges": [],
    "fields": [{"name": "greeting", "type": "string", "value": "hi"}],
    "settings": {"refreshInterval": 60},
}


@pytest.mark.asyncio
async def test_initialize_and_the_catalogue(async_client):
    response = await rpc(async_client, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}})
    assert response.status_code == 200
    result = response.json()["result"]
    assert result["protocolVersion"] == "2025-06-18"
    assert result["serverInfo"]["name"] == "frameos-backend"
    assert "confirm=true" in result["instructions"]
    assert set(result["capabilities"]) == {"tools", "resources", "prompts"}

    # An unknown version gets the newest one we speak.
    older = await rpc(async_client, "initialize", {"protocolVersion": "1999-01-01"})
    assert older.json()["result"]["protocolVersion"] == "2025-06-18"

    notified = await async_client.post("/api/mcp", json={"jsonrpc": "2.0", "method": "notifications/initialized"})
    assert notified.status_code == 202
    assert notified.content == b""

    assert (await rpc(async_client, "ping")).json()["result"] == {}

    tools = (await rpc(async_client, "tools/list")).json()["result"]["tools"]
    by_name = {tool["name"]: tool for tool in tools}
    assert {"frames_list", "frame_get", "frame_scene_install", "scenes_list", "store_browse", "ai_scene_generate", "account_info"} <= set(by_name)

    gated = {
        name
        for name, tool in by_name.items()
        if tool["inputSchema"]["properties"].get("confirm", {}).get("const") is True
    }
    assert gated == GATED_TOOLS
    for name in gated:
        tool = by_name[name]
        assert "confirm" in tool["inputSchema"]["required"], name
        assert "confirm" in tool["description"].lower() or "confirm" in tool["inputSchema"]["properties"]["confirm"]["description"], name
    for name, tool in by_name.items():
        if tool.get("annotations", {}).get("destructiveHint"):
            assert name in gated, f"{name} is destructive but not gated"
        if tool.get("annotations", {}).get("readOnlyHint"):
            assert name not in gated, f"{name} is read-only and gated"
        assert tool["description"], name
    # Project-scoped tools take project_id; account-level ones do not.
    assert "project_id" in by_name["frames_list"]["inputSchema"]["properties"]
    assert "project_id" not in by_name["account_info"]["inputSchema"]["properties"]


@pytest.mark.asyncio
async def test_protocol_errors(async_client, no_auth_client):
    unknown = (await rpc(async_client, "nope/what")).json()
    assert unknown["error"]["code"] == -32601

    missing_tool = (await rpc(async_client, "tools/call", {"name": "frame_teleport", "arguments": {}})).json()
    assert missing_tool["error"]["code"] == -32602

    no_confirm = (await rpc(async_client, "tools/call", {"name": "frame_scene_install", "arguments": {"frame_id": 1}})).json()
    assert no_confirm["error"]["code"] == -32602
    assert "confirm" in no_confirm["error"]["message"]

    false_confirm = (await rpc(async_client, "tools/call", {"name": "frame_delete", "arguments": {"frame_id": 1, "confirm": False}})).json()
    assert false_confirm["error"]["code"] == -32602

    extra_arg = (await rpc(async_client, "tools/call", {"name": "frames_list", "arguments": {"colour": "red"}})).json()
    assert extra_arg["error"]["code"] == -32602

    bad_json = await async_client.post("/api/mcp", content=b"{not json", headers={"content-type": "application/json"})
    assert bad_json.status_code == 400
    assert bad_json.json()["error"]["code"] == -32700

    not_rpc = await async_client.post("/api/mcp", json={"hello": "world"})
    assert not_rpc.json()["error"]["code"] == -32600

    batch = await async_client.post("/api/mcp", json=[
        {"jsonrpc": "2.0", "id": "a", "method": "ping"},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
    ])
    assert batch.json() == [{"jsonrpc": "2.0", "id": "a", "result": {}}]

    assert (await async_client.get("/api/mcp")).status_code == 405
    assert (await async_client.delete("/api/mcp")).status_code == 405
    assert (await no_auth_client.post("/api/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"})).status_code == 401


@pytest.mark.asyncio
async def test_frames_tools_against_the_real_routes(async_client, db: Session, redis):
    frame = await new_frame(db, redis, "Kitchen", "localhost", "localhost")
    frame.scenes = [SCENE]
    db.commit()

    listed = result_json(await call(async_client, "frames_list"))
    assert [row["name"] for row in listed["frames"]] == ["Kitchen"]
    assert listed["frames"][0]["scene_count"] == 1

    detail = result_json(await call(async_client, "frame_get", {"frame_id": frame.id}))
    assert detail["frame"]["name"] == "Kitchen"
    assert "ssh_pass" not in detail["frame"]
    assert detail["frame"]["scenes"] == [{"id": "scene-a", "name": "Hello", "default": False}]

    scenes = result_json(await call(async_client, "frame_scenes_list", {"frame_id": frame.id}))
    assert scenes["scenes"][0]["apps"] == ["render/text"]
    assert scenes["scenes"][0]["fields"] == [{"name": "greeting", "type": "string", "value": "hi"}]

    one = result_json(await call(async_client, "frame_scene_get", {"frame_id": frame.id, "scene_id": "scene-a"}))
    assert one["nodes"][0]["data"]["keyword"] == "render/text"

    # Installing the same scene JSON again gets a fresh id; saved on the
    # backend only (deploy=none) so no worker job is needed.
    installed = result_json(await call(async_client, "frame_scene_install", {
        "confirm": True, "frame_id": frame.id, "scenes": SCENE, "name": "Hello again", "deploy": "none",
    }))
    assert installed["deploy"] == "none"
    new_id = installed["installed"][0]["id"]
    assert new_id != "scene-a"
    db.expire_all()
    assert [scene["name"] for scene in frame_row(db, frame.id).scenes] == ["Hello", "Hello again"]
    assert frame_row(db, frame.id).scenes[1]["settings"]["execution"] == "interpreted"

    # Stringified scenes.json works too, and ids already present are
    # skipped when preserved.
    skipped = await call(async_client, "frame_scene_install", {
        "confirm": True, "frame_id": frame.id, "scenes": json.dumps([SCENE]), "preserve_ids": True, "deploy": "none",
    })
    assert skipped.get("isError") is True
    assert "already on the frame" in result_text(skipped)

    removed = result_json(await call(async_client, "frame_scene_remove", {
        "confirm": True, "frame_id": frame.id, "scene_id": new_id, "deploy": "none",
    }))
    assert removed["remaining"] == 1

    renamed = result_json(await call(async_client, "frame_rename", {"frame_id": frame.id, "name": "Hall"}))
    assert renamed["message"]
    db.expire_all()
    assert frame_row(db, frame.id).name == "Hall"

    updated = result_json(await call(async_client, "frame_update", {
        "confirm": True, "frame_id": frame.id, "settings": {"interval": 120, "rotate": 90},
    }))
    assert updated["frame"]["interval"] == 120
    not_settable = await call(async_client, "frame_update", {"confirm": True, "frame_id": frame.id, "settings": {"ssh_pass": "x"}})
    assert not_settable.get("isError") is True
    assert "ssh_pass" in result_text(not_settable)

    missing = await call(async_client, "frame_get", {"frame_id": 999})
    assert missing.get("isError") is True
    assert "404" in result_text(missing)

    logs = result_json(await call(async_client, "frame_logs", {"frame_id": frame.id, "limit": 5}))
    assert logs["frame_id"] == frame.id

    preview = await call(async_client, "frame_scene_preview", {"frame_id": frame.id, "scene_id": "scene-a"})
    image = next(item for item in preview["content"] if item["type"] == "image")
    assert image["mimeType"].startswith("image/")
    assert base64.b64decode(image["data"])[:4] == b"\x89PNG"


@pytest.mark.asyncio
async def test_saved_scenes_catalog_and_settings(async_client, db: Session, redis):
    frame = await new_frame(db, redis, "Kitchen", "localhost", "localhost")
    frame.scenes = [SCENE]
    db.commit()

    saved = result_json(await call(async_client, "scene_create", {"name": "Keeper", "from_frame_id": frame.id}))
    assert saved["name"] == "Keeper"
    assert saved["scene_count"] == 1
    listed = result_json(await call(async_client, "scenes_list"))
    assert [row["name"] for row in listed["scenes"]] == ["Keeper"]
    full = result_json(await call(async_client, "scene_get", {"template_id": saved["id"], "full": True}))
    assert full["scenes"][0]["id"] == "scene-a"

    installed = result_json(await call(async_client, "frame_scene_install", {
        "confirm": True, "frame_id": frame.id, "template_id": saved["id"], "deploy": "none",
    }))
    assert installed["source"] == "template"
    db.expire_all()
    assert len(frame_row(db, frame.id).scenes) == 2

    renamed = result_json(await call(async_client, "scene_update", {"template_id": saved["id"], "name": "Keeper 2"}))
    assert renamed["name"] == "Keeper 2"
    deleted = result_json(await call(async_client, "scene_delete", {"confirm": True, "template_id": saved["id"]}))
    assert deleted["message"]

    catalog = result_json(await call(async_client, "store_browse"))
    assert catalog["count"] >= 1
    bundled = next(row for row in catalog["templates"] if row["repository_slug"])
    scenes = result_json(await call(async_client, "store_scene_get", bundled["install"]))
    assert scenes["scenes"]

    updated = result_json(await call(async_client, "settings_update", {"group": "openAI", "values": {"apiKey": "sk-1234567890abcdef"}}))
    assert updated["openAI"]["apiKey"].endswith("cdef")
    assert "sk-1234567890abcdef" not in json.dumps(updated)
    got = result_json(await call(async_client, "settings_get", {"group": "openAI"}))
    assert got["openAI"]["apiKey"] == updated["openAI"]["apiKey"]

    apps = result_json(await call(async_client, "apps_list", {"search": "text"}))
    assert any(app["keyword"] == "render/text" for app in apps["apps"])

    info = result_json(await call(async_client, "account_info"))
    assert info["user"]["email"] == "test@example.com"
    assert info["auth"]["kind"] == "session"
    assert len(info["projects"]) == 1


@pytest.mark.asyncio
async def test_resources_and_prompts(async_client, db: Session, redis):
    frame = await new_frame(db, redis, "Kitchen", "localhost", "localhost")
    frame.scenes = [SCENE]
    db.commit()

    listed = (await rpc(async_client, "resources/list")).json()["result"]["resources"]
    uris = {resource["uri"] for resource in listed}
    assert {"frameos://frames", "frameos://scenes", f"frameos://frames/{frame.id}", f"frameos://frames/{frame.id}/scenes/scene-a"} <= uris

    templates = (await rpc(async_client, "resources/templates/list")).json()["result"]["resourceTemplates"]
    assert {template["uriTemplate"] for template in templates} == {"frameos://frames/{frame_id}", "frameos://frames/{frame_id}/scenes/{scene_id}"}

    read = (await rpc(async_client, "resources/read", {"uri": f"frameos://frames/{frame.id}"})).json()["result"]
    assert json.loads(read["contents"][0]["text"])["frame"]["name"] == "Kitchen"
    scene = (await rpc(async_client, "resources/read", {"uri": f"frameos://frames/{frame.id}/scenes/scene-a"})).json()["result"]
    assert json.loads(scene["contents"][0]["text"])["name"] == "Hello"
    unknown = (await rpc(async_client, "resources/read", {"uri": "frameos://nothing"})).json()
    assert unknown["error"]["code"] == -32602

    prompts = (await rpc(async_client, "prompts/list")).json()["result"]["prompts"]
    assert {prompt["name"] for prompt in prompts} == {"diagnose_frame", "build_scene"}
    got = (await rpc(async_client, "prompts/get", {"name": "diagnose_frame", "arguments": {"frame_id": str(frame.id)}})).json()["result"]
    assert f"Diagnose frame {frame.id}" in got["messages"][0]["content"]["text"]
    needs_arg = (await rpc(async_client, "prompts/get", {"name": "diagnose_frame"})).json()
    assert needs_arg["error"]["code"] == -32602


@pytest.mark.asyncio
async def test_api_tokens_drive_the_mcp(async_client, db: Session, redis):
    frame = await new_frame(db, redis, "Kitchen", "localhost", "localhost")
    full = await mint_token(async_client)
    read_only = await mint_token(async_client, access="read_only")

    info = result_json(await call(async_client, "account_info", headers=full))
    assert info["auth"] == {"kind": "api_token", "token_name": "agent", "token_access": "full"}

    renamed = result_json(await call(async_client, "frame_rename", {"frame_id": frame.id, "name": "Hall"}, headers=full))
    assert renamed["message"]

    # A read-only token reaches the endpoint (the POST is the transport)
    # but its mutations are refused by the routes themselves.
    listed = result_json(await call(async_client, "frames_list", headers=read_only))
    assert listed["frames"][0]["name"] == "Hall"
    refused = await call(async_client, "frame_rename", {"frame_id": frame.id, "name": "Nope"}, headers=read_only)
    assert refused.get("isError") is True
    assert "read_only_token" in result_text(refused)
    assert "read-only" in result_text(refused)
    db.expire_all()
    assert frame_row(db, frame.id).name == "Hall"

    tokens = result_json(await call(async_client, "api_tokens_list", headers=read_only))
    assert tokens["can_create"] is False
    assert len(tokens["api_tokens"]) == 2


def test_duplicate_scenes_rewrites_references():
    scenes = [
        {"id": "a", "name": "A", "nodes": [{"id": "n", "type": "scene", "data": {"keyword": "b"}}], "edges": [], "default": True},
        {"id": "b", "name": "B", "nodes": [], "edges": []},
    ]
    copied = duplicate_scenes(scenes)
    assert copied[0]["id"] != "a" and copied[1]["id"] != "b"
    assert copied[0]["nodes"][0]["data"]["keyword"] == copied[1]["id"]
    assert "default" not in copied[0]
    # The input is untouched.
    assert scenes[0]["id"] == "a"


def test_schema_validation_subset():
    schema = {
        "type": "object",
        "properties": {
            "n": {"type": "integer", "minimum": 1},
            "s": {"type": ["string", "null"], "enum": ["a", "b", None]},
            "items": {"type": "array", "items": {"type": "string"}, "maxItems": 2},
            "confirm": {"type": "boolean", "const": True},
        },
        "required": ["n"],
        "additionalProperties": False,
    }
    validate_value(schema, {"n": 1, "s": "a", "items": ["x"], "confirm": True}, "")
    for bad in ({}, {"n": 0}, {"n": True}, {"n": 1, "s": "c"}, {"n": 1, "items": ["a", "b", "c"]}, {"n": 1, "confirm": False}, {"n": 1, "x": 1}):
        with pytest.raises(SchemaError):
            validate_value(schema, bad, "")


def test_uri_templates():
    assert match_uri_template("frameos://frames/{frame_id}", "frameos://frames/3") == {"frame_id": "3"}
    assert match_uri_template("frameos://frames/{frame_id}/scenes/{scene_id}", "frameos://frames/3/scenes/x-y") == {"frame_id": "3", "scene_id": "x-y"}
    assert match_uri_template("frameos://frames/{frame_id}", "frameos://frames/3/scenes/x") is None
