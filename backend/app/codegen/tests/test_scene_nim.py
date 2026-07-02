from types import SimpleNamespace

from app.codegen.scene_nim import (
    scene_library_filename,
    write_scene_library_nim,
    write_scene_nim,
    write_scenes_nim,
    write_shared_scenes_bundle_library_nim,
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
    assert 'frameosEventPayloadValueMatches(context.payload, "key", "Enter")' in source
    assert 'frameosEventPayloadValueMatches(context.payload, "code", "13")' in source


def test_shared_scene_registry_loads_scene_libraries():
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

    source = write_scenes_nim(frame, compilation_mode="shared")

    assert 'libraryName: "scene_myscene.so"' in source
    assert '"my-scene".SceneId' in source
    assert "loadLib(path)" in source
    assert '"frameos_scene_init"' in source
    assert '"frameos_scene_export"' in source
    assert "scene_live_scene" not in source


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

    source = write_scenes_nim(frame, compilation_mode="static")

    assert "import scenes/scene_myscene as scene_myscene" in source
    assert 'result["my-scene".SceneId] = scene_myscene.exportedScene' in source
    assert "loadLib(path)" not in source
    assert 'libraryName: "scene_myscene.so"' not in source
    assert "scene_live_scene" not in source


def test_scene_library_wrapper_exports_scene_symbols():
    scene = {"id": "my-scene", "name": "My Scene"}
    source = write_scene_library_nim(scene)

    assert scene_library_filename(scene) == "scene_myscene.so"
    assert "import scenes/scene_myscene as sceneModule" in source
    assert "proc frameos_scene_init*" in source
    assert "setSharedHostCallbacks(logHook, sendEventHook)" in source
    assert "proc frameos_scene_export*" in source


def test_shared_scene_bundle_registry_loads_scene_symbols_without_wrappers():
    frame = SimpleNamespace(
        scenes=[
            {
                "id": "my-scene",
                "name": "My Scene",
                "default": True,
                "settings": {"execution": "compiled"},
            },
        ]
    )

    source = write_scenes_nim(frame, compilation_mode="shared-scenes")

    assert 'initSymbol: "frameos_scene_init_myscene"' in source
    assert 'exportSymbol: "frameos_scene_export_myscene"' in source
    assert 'libraryName: "scenes.so"' in source
    assert "loadLib(path)" in source
    assert "scene_myscene.exportedScene" not in source
    assert "hostChannels.setSharedHostCallbacks(logHook, sendEventHook)" not in source
    assert ".frameos_scene_init(logHook, sendEventHook)" not in source


def test_shared_scene_bundle_library_exports_scene_symbols_without_scene_wrapper_init():
    frame = SimpleNamespace(
        scenes=[
            {
                "id": "my-scene",
                "name": "My Scene",
                "default": True,
                "settings": {"execution": "compiled"},
            },
        ]
    )

    source = write_shared_scenes_bundle_library_nim(frame)

    assert "proc frameos_scene_init_myscene*" in source
    assert "hostChannels.setSharedHostCallbacks(logHook, sendEventHook)" in source
    assert ".frameos_scene_init(logHook, sendEventHook)" not in source
    assert "result = cast[pointer](scene_myscene.exportedScene)" in source


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
