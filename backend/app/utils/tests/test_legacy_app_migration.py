from app.utils.legacy_app_migration import (
    migrate_legacy_apps_in_scene,
    migrate_legacy_apps_in_scenes,
)
from app.utils.scene_execution import scene_requires_compilation


def app_node(node_id: str, keyword: str, config: dict | None = None, **extra) -> dict:
    return {
        "id": node_id,
        "type": "app",
        "position": {"x": 100, "y": 300},
        "data": {"keyword": keyword, "config": config or {}, **extra},
    }


def scene_with(nodes: list[dict], edges: list[dict] | None = None, apps: dict | None = None) -> dict:
    scene = {"id": "scene-1", "name": "Test", "nodes": nodes, "edges": edges or []}
    if apps is not None:
        scene["apps"] = apps
    return scene


def nodes_by_keyword(scene: dict) -> dict:
    return {n["data"]["keyword"]: n for n in scene["nodes"]}


def field_edges(scene: dict) -> list[dict]:
    return [e for e in scene["edges"] if e.get("sourceHandle") == "fieldOutput"]


def test_untouched_scene_returns_false():
    scene = scene_with([app_node("a", "render/text"), app_node("b", "data/clock")])
    assert migrate_legacy_apps_in_scene(scene) is False
    assert len(scene["nodes"]) == 2
    assert scene["edges"] == []


def test_clock_becomes_render_text_fed_by_data_clock():
    node = app_node("clock-1", "legacy/clock", {"position": "top-right", "fontSize": "48", "format": "HH:mm"})
    scene = scene_with([node])
    assert migrate_legacy_apps_in_scene(scene) is True

    assert node["data"]["keyword"] == "render/text"
    config = node["data"]["config"]
    assert config["position"] == "right"
    assert config["vAlign"] == "top"
    assert config["fontSize"] == "48"
    assert config["overflow"] == "visible"
    # legacy defaults materialized
    assert config["fontColor"] == "#ffffff"
    assert config["borderWidth"] == "2"
    assert "format" not in config

    data_node = nodes_by_keyword(scene)["data/clock"]
    assert data_node["data"]["config"] == {"format": "HH:mm", "formatCustom": ""}
    assert "cache" not in data_node["data"]

    [edge] = field_edges(scene)
    assert edge["source"] == data_node["id"]
    assert edge["target"] == "clock-1"
    assert edge["targetHandle"] == "fieldInput/text"


def test_download_image_becomes_render_image_with_cache():
    node = app_node("dl-1", "legacy/downloadImage", {"url": "https://example.com/a.jpg", "scalingMode": "contain"})
    scene = scene_with([node])
    assert migrate_legacy_apps_in_scene(scene) is True

    assert node["data"]["keyword"] == "render/image"
    assert node["data"]["config"] == {"placement": "contain"}

    data_node = nodes_by_keyword(scene)["data/downloadImage"]
    assert data_node["data"]["config"] == {"url": "https://example.com/a.jpg"}
    # legacy default cacheSeconds=3600 becomes a node cache
    assert data_node["data"]["cache"] == {
        "enabled": True,
        "inputEnabled": True,
        "durationEnabled": True,
        "duration": "3600",
    }

    [edge] = field_edges(scene)
    assert edge["targetHandle"] == "fieldInput/image"


def test_zero_cache_seconds_means_no_cache():
    node = app_node("dl-2", "legacy/downloadImage", {"cacheSeconds": "0"})
    scene = scene_with([node])
    migrate_legacy_apps_in_scene(scene)
    data_node = nodes_by_keyword(scene)["data/downloadImage"]
    assert "cache" not in data_node["data"]


def test_local_image_materializes_legacy_default_path():
    # data/localImage's default path differs from the legacy default,
    # so the legacy default must be written out explicitly.
    node = app_node("li-1", "legacy/localImage", {"order": "alphabetical"})
    scene = scene_with([node])
    migrate_legacy_apps_in_scene(scene)

    data_node = nodes_by_keyword(scene)["data/localImage"]
    assert data_node["data"]["config"] == {
        "path": "/srv/images",
        "order": "alphabetical",
        "counterStateKey": "",
    }
    assert data_node["data"]["cache"]["duration"] == "900"


def test_ha_sensor_becomes_set_as_state():
    node = app_node("ha-1", "legacy/haSensor", {"entityId": "sensor.temp", "stateKey": "", "cacheSeconds": "30"})
    scene = scene_with([node])
    migrate_legacy_apps_in_scene(scene)

    assert node["data"]["keyword"] == "logic/setAsState"
    # empty stateKey fell back to "state" in the legacy app
    assert node["data"]["config"] == {"stateKey": "state"}

    data_node = nodes_by_keyword(scene)["data/haSensor"]
    assert data_node["data"]["config"] == {"entityId": "sensor.temp", "debug": "false"}
    assert data_node["data"]["cache"]["duration"] == "30"

    [edge] = field_edges(scene)
    assert edge["targetHandle"] == "fieldInput/valueJson"


def test_ha_sensor_default_state_key_is_sensor():
    node = app_node("ha-2", "legacy/haSensor", {"entityId": "sensor.x"})
    scene = scene_with([node])
    migrate_legacy_apps_in_scene(scene)
    assert node["data"]["config"] == {"stateKey": "sensor"}


def test_openai_text_becomes_set_as_state_with_value_string():
    node = app_node("ot-1", "legacy/openaiText", {"user": "haiku please", "stateKey": "poem"})
    scene = scene_with([node])
    migrate_legacy_apps_in_scene(scene)

    assert node["data"]["keyword"] == "logic/setAsState"
    assert node["data"]["config"] == {"stateKey": "poem"}

    data_node = nodes_by_keyword(scene)["data/openaiText"]
    assert data_node["data"]["config"]["user"] == "haiku please"
    assert data_node["data"]["config"]["model"] == "gpt-5.5"

    [edge] = field_edges(scene)
    assert edge["targetHandle"] == "fieldInput/valueString"


def test_qr_maps_position_to_placement():
    node = app_node("qr-1", "legacy/qr", {"position": "bottom-right", "offsetX": "5", "code": "hello", "codeType": "Custom"})
    scene = scene_with([node])
    migrate_legacy_apps_in_scene(scene)

    assert node["data"]["keyword"] == "render/image"
    assert node["data"]["config"] == {"placement": "bottom-right", "offsetX": "5", "offsetY": "0"}

    data_node = nodes_by_keyword(scene)["data/qr"]
    assert data_node["data"]["config"]["code"] == "hello"
    assert data_node["data"]["config"]["codeType"] == "Custom"
    assert "cache" not in data_node["data"]


def test_qr_center_center_becomes_center():
    node = app_node("qr-2", "legacy/qr", {})
    scene = scene_with([node])
    migrate_legacy_apps_in_scene(scene)
    assert node["data"]["config"]["placement"] == "center"


def test_unsplash_keyword_becomes_search():
    node = app_node("un-1", "legacy/unsplash", {"keyword": "mountains"})
    scene = scene_with([node])
    migrate_legacy_apps_in_scene(scene)
    data_node = nodes_by_keyword(scene)["data/unsplash"]
    assert data_node["data"]["config"] == {"search": "mountains"}


def test_openai_becomes_openai_image():
    node = app_node("oa-1", "legacy/openai", {"prompt": "a fox", "model": "dall-e-3"})
    scene = scene_with([node])
    migrate_legacy_apps_in_scene(scene)
    data_node = nodes_by_keyword(scene)["data/openaiImage"]
    assert data_node["data"]["config"]["prompt"] == "a fox"
    assert data_node["data"]["config"]["model"] == "dall-e-3"
    assert node["data"]["keyword"] == "render/image"


def test_resize_and_rotate_are_marked_for_conversion_not_inlined():
    resize = app_node("rs-1", "legacy/resize", {"width": "800", "height": "480"})
    rotate = app_node("ro-1", "legacy/rotate", {"rotationDegree": "90"})
    scene = scene_with([resize, rotate])
    assert migrate_legacy_apps_in_scene(scene) is True

    # no new nodes or edges, and no Nim: a migration never manufactures a
    # compiled scene any more
    assert len(scene["nodes"]) == 2
    assert scene["edges"] == []
    for node in (resize, rotate):
        assert "sources" not in node["data"]
        assert node["data"]["needsConversion"]["source"] == node["data"]["keyword"]
        assert "mid-chain" in node["data"]["needsConversion"]["reason"]
    # keyword and config values survive untouched
    assert resize["data"]["keyword"] == "legacy/resize"
    assert resize["data"]["config"] == {"width": "800", "height": "480"}
    assert not scene_requires_compilation(scene)

def test_render_chain_edges_survive():
    render_event = {"id": "ev", "type": "event", "position": {"x": 0, "y": 0}, "data": {"keyword": "render"}}
    node = app_node("dl-3", "legacy/downloadImage")
    after = app_node("txt", "render/text")
    edges = [
        {"id": "e1", "source": "ev", "sourceHandle": "next", "target": "dl-3", "targetHandle": "prev"},
        {"id": "e2", "source": "dl-3", "sourceHandle": "next", "target": "txt", "targetHandle": "prev"},
    ]
    scene = scene_with([render_event, node, after], edges)
    migrate_legacy_apps_in_scene(scene)

    # the node keeps its id, so the chain is untouched
    chain = [e for e in scene["edges"] if e["id"] in ("e1", "e2")]
    assert len(chain) == 2
    assert node["data"]["keyword"] == "render/image"


def test_node_with_sources_is_left_alone():
    node = app_node("ed-1", "legacy/clock", {"format": "HH:mm"}, sources={"app.nim": "custom code"})
    scene = scene_with([node])
    assert migrate_legacy_apps_in_scene(scene) is False
    assert node["data"]["keyword"] == "legacy/clock"
    assert node["data"]["sources"] == {"app.nim": "custom code"}


def test_scene_level_edited_app_is_left_alone():
    node = app_node("ed-2", "legacy/clock")
    scene = scene_with([node], apps={"legacy/clock": {"sources": {"app.nim": "custom code"}}})
    assert migrate_legacy_apps_in_scene(scene) is False
    assert node["data"]["keyword"] == "legacy/clock"


def test_deterministic_ids():
    def build():
        scene = scene_with([app_node("dl-9", "legacy/downloadImage")])
        migrate_legacy_apps_in_scene(scene)
        return scene

    a, b = build(), build()
    assert [n["id"] for n in a["nodes"]] == [n["id"] for n in b["nodes"]]
    assert [e["id"] for e in a["edges"]] == [e["id"] for e in b["edges"]]


def test_bare_pre_category_keywords_are_migrated_too():
    # scenes that predate app categories used e.g. "clock" instead of "legacy/clock"
    node = app_node("old-1", "clock", {"position": "bottom-center"})
    scene = scene_with([node])
    assert migrate_legacy_apps_in_scene(scene) is True
    assert node["data"]["keyword"] == "render/text"
    assert node["data"]["config"]["vAlign"] == "bottom"
    assert "data/clock" in nodes_by_keyword(scene)

    resize = app_node("old-2", "resize")
    scene = scene_with([resize])
    assert migrate_legacy_apps_in_scene(scene) is True
    assert resize["data"]["keyword"] == "legacy/resize"
    assert "sources" not in resize["data"]
    assert resize["data"]["needsConversion"]["source"] == "legacy/resize"


def test_bare_keyword_with_node_sources_is_left_alone():
    node = app_node("old-3", "clock", {}, sources={"app.nim": "custom"})
    scene = scene_with([node])
    assert migrate_legacy_apps_in_scene(scene) is False
    assert node["data"]["keyword"] == "clock"


def test_migrate_scenes_list():
    scenes = [
        scene_with([app_node("a", "legacy/qr")]),
        scene_with([app_node("b", "render/text")]),
        "not-a-scene",
    ]
    assert migrate_legacy_apps_in_scenes(scenes) is True
    assert migrate_legacy_apps_in_scenes([scene_with([app_node("c", "render/text")])]) is False
    assert migrate_legacy_apps_in_scenes(None) is False
