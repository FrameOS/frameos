from types import SimpleNamespace

from app.codegen.scene_nim import write_scene_nim


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
