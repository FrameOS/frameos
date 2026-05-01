from types import SimpleNamespace

from app.codegen.scene_nim import write_scene_nim
from app.models.apps import get_scene_app_id


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
                "data": {"keyword": "repo/examples/jsText", "config": {}},
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
            "repo/examples/jsText": {
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
        "          self.node2.get(context)\n"
        "        frameosValue.asString()"
    ) in source


def test_scene_app_import_uses_source_specific_module_id():
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
                "data": {"keyword": "repo/examples/jsText", "config": {}},
                "position": {"x": 0, "y": 0},
            },
        ],
        "edges": [],
        "fields": [],
        "settings": {"execution": "compiled", "refreshInterval": 3600, "backgroundColor": "#000000"},
        "apps": {"repo/examples/jsText": {"sources": sources}},
    }
    frame = SimpleNamespace(interval=3600, debug=False, scenes=[])

    source = write_scene_nim(frame, scene)

    assert f"import apps/{get_scene_app_id('repo/examples/jsText', sources)}/app as nodeApp1" in source


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
