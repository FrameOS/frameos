from types import SimpleNamespace

from app.codegen.scene_nim import (
    write_scene_nim,
    write_scenes_nim,
)


def test_app_output_field_input_is_coerced_to_target_field_type():
    scene = {
        "id": "scene",
        "name": "Scene",
        "nodes": [
            {"id": "event", "type": "event", "data": {"keyword": "render"}, "position": {"x": 0, "y": 0}},
            {"id": "text", "type": "app", "data": {"keyword": "render/text", "config": {}}, "position": {"x": 1, "y": 1}},
            {
                "id": "js",
                "type": "app",
                "data": {"keyword": "jsText", "config": {}},
                "position": {"x": 2, "y": 2},
            },
        ],
        "edges": [
            {"source": "event", "sourceHandle": "next", "target": "text", "targetHandle": "prev"},
            {
                "source": "js",
                "sourceHandle": "fieldOutput",
                "target": "text",
                "targetHandle": "fieldInput/text",
            },
        ],
        "fields": [],
        "settings": {"execution": "compiled", "refreshInterval": 3600, "backgroundColor": "#000000"},
        "apps": {
            "jsText": {
                "origin": "repo/apps/code/jsText",
                "sources": {
                    "config.json": """
{
  "name": "JS Text",
  "category": "data",
  "fields": [],
  "output": [{"name": "text", "type": "text"}]
}
""",
                    "app.ts": "export function get(): string { return 'hello' }\n",
                }
            }
        },
    }
    frame = SimpleNamespace(interval=3600, debug=False, scenes=[])

    source = write_scene_nim(frame, scene)

    assert (
        "self.node1.appConfig.text = block:\n"
        "        let frameosValue = block:\n"
        "          js_app_runtime.getDynamicJsApp(self.node2, context)\n"
        "        frameosValue.asString()"
    ) in source


def test_scene_js_app_uses_runtime_directly():
    sources = {
        "config.json": """
{
  "name": "JS Text",
  "category": "data",
  "fields": [],
  "output": [{"name": "text", "type": "text"}]
}
""",
        "app.ts": "export function get(): string { return 'hello' }\n",
    }
    scene = {
        "id": "scene",
        "name": "Scene",
        "nodes": [
            {
                "id": "js",
                "type": "app",
                "data": {"keyword": "jsText", "config": {}},
                "position": {"x": 0, "y": 0},
            },
        ],
        "edges": [],
        "fields": [],
        "settings": {"execution": "compiled", "refreshInterval": 3600, "backgroundColor": "#000000"},
        "apps": {"jsText": {"origin": "repo/apps/code/jsText", "sources": sources}},
    }
    frame = SimpleNamespace(interval=3600, debug=False, scenes=[])

    source = write_scene_nim(frame, scene)

    assert "import frameos/js_app_runtime as js_app_runtime" in source
    assert "js_app_runtime.initDynamicJsApp" in source
    assert "import apps/" not in source
    assert "app_loader" not in source


def test_missing_app_without_sources_raises_clear_error():
    scene = {
        "id": "scene",
        "name": "Scene",
        "nodes": [
            {
                "id": "missing",
                "type": "app",
                "data": {"keyword": "missing/app", "config": {}},
                "position": {"x": 0, "y": 0},
            },
        ],
        "edges": [],
        "fields": [],
        "settings": {"execution": "compiled", "refreshInterval": 3600, "backgroundColor": "#000000"},
    }
    frame = SimpleNamespace(interval=3600, debug=False, scenes=[])

    try:
        write_scene_nim(frame, scene)
        assert False, "Expected missing app to raise"
    except ValueError as error:
        assert 'App "missing/app" for node "missing" not found' in str(error)
        assert "NoneType" not in str(error)


def test_scene_app_with_empty_sources_raises_clear_error():
    scene = {
        "id": "scene",
        "name": "Scene",
        "nodes": [
            {
                "id": "js",
                "type": "app",
                "data": {"keyword": "jsText", "config": {}},
                "position": {"x": 0, "y": 0},
            },
        ],
        "edges": [],
        "fields": [],
        "settings": {"execution": "compiled", "refreshInterval": 3600, "backgroundColor": "#000000"},
        "apps": {
            "jsText": {
                "origin": "repo/apps/code/jsText",
                "sources": {},
            }
        },
    }
    frame = SimpleNamespace(interval=3600, debug=False, scenes=[])

    try:
        write_scene_nim(frame, scene)
        assert False, "Expected empty scene app sources to raise"
    except ValueError as error:
        assert 'App "jsText" for node "js" not found' in str(error)
        assert "NoneType" not in str(error)


def test_native_app_output_field_input_keeps_native_return_type():
    scene = {
        "id": "scene",
        "name": "Scene",
        "nodes": [
            {"id": "event", "type": "event", "data": {"keyword": "render"}, "position": {"x": 0, "y": 0}},
            {"id": "text", "type": "app", "data": {"keyword": "render/text", "config": {}}, "position": {"x": 1, "y": 1}},
            {"id": "clock", "type": "app", "data": {"keyword": "data/clock", "config": {}}, "position": {"x": 2, "y": 2}},
        ],
        "edges": [
            {"source": "event", "sourceHandle": "next", "target": "text", "targetHandle": "prev"},
            {
                "source": "clock",
                "sourceHandle": "fieldOutput",
                "target": "text",
                "targetHandle": "fieldInput/text",
            },
        ],
        "fields": [],
        "settings": {"execution": "compiled", "refreshInterval": 3600, "backgroundColor": "#000000"},
    }
    frame = SimpleNamespace(interval=3600, debug=False, scenes=[])

    source = write_scene_nim(frame, scene)

    assert "self.node1.appConfig.text = block:\n        self.node2.get(context)" in source
    assert "self.node2.get(context).asString()" not in source


def test_custom_event_dispatch_uses_scene_event_fields():
    scene = {
        "id": "scene",
        "name": "Scene",
        "nodes": [
            {"id": "event", "type": "event", "data": {"keyword": "render"}, "position": {"x": 0, "y": 0}},
            {
                "id": "dispatch",
                "type": "dispatch",
                "data": {"keyword": "photoSelected", "config": {"message": "hello", "count": "3"}},
                "position": {"x": 1, "y": 1},
            },
        ],
        "edges": [
            {"source": "event", "sourceHandle": "next", "target": "dispatch", "targetHandle": "prev"},
        ],
        "fields": [],
        "customEvents": [
            {
                "name": "photoSelected",
                "description": "Photo selected",
                "fields": [
                    {"name": "message", "label": "Message", "type": "string"},
                    {"name": "count", "label": "Count", "type": "integer"},
                ],
            }
        ],
        "settings": {"execution": "compiled", "refreshInterval": 3600, "backgroundColor": "#000000"},
    }
    frame = SimpleNamespace(interval=3600, debug=False, scenes=[])

    source = write_scene_nim(frame, scene)

    assert 'sendEvent("photoSelected", %*{' in source
    assert 'message: "hello"' in source
    assert "count: 3" in source


def test_event_listener_filters_match_configured_payload_fields():
    scene = {
        "id": "scene",
        "name": "Scene",
        "nodes": [
            {
                "id": "event",
                "type": "event",
                "data": {"keyword": "keyUp", "config": {"key": "Enter", "code": "13"}},
                "position": {"x": 0, "y": 0},
            },
            {"id": "clock", "type": "app", "data": {"keyword": "data/clock", "config": {}}, "position": {"x": 1, "y": 1}},
        ],
        "edges": [
            {"source": "event", "sourceHandle": "next", "target": "clock", "targetHandle": "prev"},
        ],
        "fields": [],
        "settings": {"execution": "compiled", "refreshInterval": 3600, "backgroundColor": "#000000"},
    }
    frame = SimpleNamespace(interval=3600, debug=False, scenes=[])

    source = write_scene_nim(frame, scene)

    assert 'of "keyUp":' in source
    assert 'eventPayloadValueMatches(context.payload, "key", "Enter")' in source
    assert 'eventPayloadValueMatches(context.payload, "code", "13")' in source


def test_static_scene_registry_imports_compiled_scenes():
    frame = SimpleNamespace(
        scenes=[
            {
                "id": "my-scene",
                "name": "My Scene",
                "default": True,
                "settings": {"execution": "compiled"},
            },
            {
                "id": "live-scene",
                "name": "Live Scene",
                "settings": {"execution": "interpreted"},
            },
        ]
    )

    for compilation_mode in ("static", "precompiled", "shared", "shared-scenes"):
        source = write_scenes_nim(frame, compilation_mode=compilation_mode)

        assert "import scenes/scene_myscene as scene_myscene" in source
        assert 'result["my-scene".SceneId] = scene_myscene.exportedScene' in source
        # No mode dlopens a scene any more, including the two retired values a
        # frame may still have stored.
        assert "loadLib(path)" not in source
        assert 'libraryName: "scene_myscene.so"' not in source
        assert "scene_live_scene" not in source


def test_public_state_fields_include_value_and_show_if():
    scene = {
        "id": "scene",
        "name": "Scene",
        "nodes": [
            {"id": "event", "type": "event", "data": {"keyword": "render"}, "position": {"x": 0, "y": 0}},
        ],
        "edges": [],
        "fields": [
            {"name": "showMetadata", "type": "boolean", "value": "true", "access": "public", "persist": "disk"},
            {
                "name": "metadataPosition",
                "type": "select",
                "options": ["top", "bottom"],
                "value": "bottom",
                "access": "public",
                "persist": "disk",
                "showIf": [{"field": "showMetadata", "operator": "eq", "value": True}],
            },
            {"name": "counter", "type": "integer", "value": "5", "access": "private", "persist": "memory"},
        ],
        "settings": {"execution": "compiled", "refreshInterval": 3600, "backgroundColor": "#000000"},
        "apps": {},
    }
    frame = SimpleNamespace(interval=3600, debug=False, scenes=[])

    source = write_scene_nim(frame, scene)

    assert 'StateField(name: "showMetadata"' in source
    assert "value: %*(true)" in source
    # showIf conditions survive into the generated StateField as JSON
    assert (
        'showIf: parseJson("[{\\"field\\": \\"showMetadata\\", \\"operator\\": \\"eq\\", \\"value\\": true}]")'
        in source
    )
    # private fields stay out of PUBLIC_STATE_FIELDS but still seed state
    assert 'StateField(name: "counter"' not in source
    assert '"counter": %*(5)' in source


def _fusion_scene(consumer_config=None, producer_cache=False, extra_edges=None, extra_nodes=None):
    scene = {
        "id": "scene",
        "name": "Fusion",
        "nodes": [
            {"id": "event", "type": "event", "data": {"keyword": "render"}, "position": {"x": 0, "y": 0}},
            {"id": "img", "type": "app", "data": {"keyword": "render/image",
                "config": consumer_config or {}}, "position": {"x": 1, "y": 1}},
            {"id": "dl", "type": "app", "data": {"keyword": "data/downloadImage",
                "config": {"url": "https://example.com/a.jpg"},
                "cache": {"enabled": producer_cache}}, "position": {"x": 2, "y": 2}},
            *(extra_nodes or []),
        ],
        "edges": [
            {"source": "event", "sourceHandle": "next", "target": "img", "targetHandle": "prev"},
            {"source": "dl", "sourceHandle": "fieldOutput", "target": "img", "targetHandle": "fieldInput/image"},
            *(extra_edges or []),
        ],
        "fields": [],
        "settings": {"execution": "compiled", "refreshInterval": 3600, "backgroundColor": "#000000"},
        "apps": {},
    }
    return scene


def _frame():
    return SimpleNamespace(interval=3600, debug=False, scenes=[])


def test_compiled_scene_offers_live_canvas_to_uncached_producer():
    # Phase 4 of docs/value-pipeline.md: the same negotiation the interpreted
    # planner does at scene load, emitted statically at codegen. An uncached
    # intoTarget producer feeding a full-frame render/image decodes straight
    # into the live canvas.
    source = write_scene_nim(_frame(), _fusion_scene())
    assert "context.decodeTargetImage = context.image" in source
    assert 'context.decodeTargetScalingMode = "cover"' in source
    assert "context.decodeTargetNodeId = 2.NodeId" in source
    # And the offer is cleared after the producer ran, taken or not.
    assert "context.decodeTargetNodeId = 0.NodeId" in source


def test_compiled_scene_gives_cached_producer_an_owned_scratch():
    # A cached producer must not end up holding the live canvas; it gets a
    # canvas-sized target it allocates for itself, and the cache stores that.
    source = write_scene_nim(_frame(), _fusion_scene(producer_cache=True))
    assert "context.decodeTargetWidth = context.image.width" in source
    assert "context.decodeTargetOwned = true" in source
    assert "context.decodeTargetImage = context.image" not in source


def test_compiled_scene_refuses_semantics_changing_shapes():
    # A blend beyond normal/overwrite would change pixels; the floor stands.
    source = write_scene_nim(_frame(), _fusion_scene(consumer_config={"blendMode": "mask"}))
    assert "decodeTarget" not in source

    # contain + overwrite over an app-owned scratch would carry the scratch's
    # transparent margins over the canvas (ownedTargetExcludes).
    source = write_scene_nim(_frame(), _fusion_scene(
        consumer_config={"placement": "contain", "blendMode": "overwrite"},
        producer_cache=True))
    assert "decodeTarget" not in source
    # ...but the same shape on the live canvas has no margins of its own.
    source = write_scene_nim(_frame(), _fusion_scene(
        consumer_config={"placement": "contain", "blendMode": "overwrite"}))
    assert "context.decodeTargetImage = context.image" in source


def test_compiled_scene_refuses_wired_placement_and_cached_consumer():
    # A wired placement is dynamic; compiled fusion is static-only for now.
    scene = _fusion_scene(
        extra_nodes=[{"id": "st", "type": "state", "data": {"keyword": "scaling"},
                      "position": {"x": 3, "y": 3}}],
        extra_edges=[{"source": "st", "sourceHandle": "fieldOutput",
                      "target": "img", "targetHandle": "fieldInput/placement"}])
    scene["fields"] = [{"name": "scaling", "type": "string", "value": "cover"}]
    source = write_scene_nim(_frame(), scene)
    assert "decodeTarget" not in source

    # A cached consumer cannot own the canvas it is drawn onto.
    scene = _fusion_scene()
    scene["nodes"][1]["data"]["cache"] = {"enabled": True}
    source = write_scene_nim(_frame(), scene)
    assert "decodeTarget" not in source


def _color_fill_scene(color, consumer_config=None, producer_cache=False):
    scene = _fusion_scene(consumer_config=consumer_config, producer_cache=producer_cache)
    scene["nodes"][2] = {"id": "dl", "type": "app", "data": {"keyword": "render/color",
        "config": {"color": color}, "cache": {"enabled": producer_cache}},
        "position": {"x": 2, "y": 2}}
    return scene


def test_compiled_scene_fuses_an_opaque_color_fill():
    # The opaque-output capability (requireOpaqueColor): a generator whose
    # paint is provably opaque overwrites every pixel, so it may claim the
    # live canvas. Its fit is natural — target-sized under every placement —
    # so a non-decoder placement like center fuses too.
    source = write_scene_nim(_frame(), _color_fill_scene("#336699"))
    assert "context.decodeTargetImage = context.image" in source

    source = write_scene_nim(_frame(), _color_fill_scene(
        "#336699", consumer_config={"placement": "center"}))
    assert "context.decodeTargetImage = context.image" in source

    # Cached, it gets a scratch of its own, never the canvas.
    source = write_scene_nim(_frame(), _color_fill_scene("#336699", producer_cache=True))
    assert "context.decodeTargetWidth = context.image.width" in source
    assert "context.decodeTargetImage = context.image" not in source


def test_compiled_scene_keeps_a_wired_fill_color_on_the_floor():
    # A compiled scene config can only hold opaque 6-digit hex (wrap_color
    # rejects anything else at codegen), so the shape requireOpaqueColor
    # guards here is a WIRED color: it could resolve semi-transparent at
    # render time, and "tint the photo" must never erase the photo.
    scene = _color_fill_scene("#336699")
    scene["nodes"].append({"id": "st", "type": "state", "data": {"keyword": "tint"},
                           "position": {"x": 3, "y": 3}})
    scene["edges"].append({"source": "st", "sourceHandle": "fieldOutput",
                           "target": "dl", "targetHandle": "fieldInput/color"})
    scene["fields"] = [{"name": "tint", "type": "string", "value": "#336699"}]
    source = write_scene_nim(_frame(), scene)
    assert "decodeTarget" not in source
