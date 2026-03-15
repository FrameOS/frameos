from types import SimpleNamespace

from app.codegen.scene_nim import write_scene_nim, write_scene_plugin_nim


def test_write_scene_nim_uses_module_name_for_compiled_child_scene_imports(
    monkeypatch,
):
    monkeypatch.setattr("app.codegen.scene_nim.get_local_frame_apps", lambda: [])

    child_scene_id = "03fe741a-75cf-4653-b77b-d2b42b7e0a94"
    parent_scene = {
        "id": "parent",
        "name": "Parent",
        "nodes": [
            {"id": "start", "type": "event", "data": {"keyword": "render", "config": {}}},
            {"id": "child", "type": "scene", "data": {"keyword": child_scene_id, "config": {}}},
        ],
        "edges": [
            {
                "source": "start",
                "sourceHandle": "next",
                "target": "child",
                "targetHandle": "prev",
            }
        ],
    }
    child_scene = {
        "id": child_scene_id,
        "name": "Child",
        "nodes": [],
        "settings": {"execution": "compiled"},
    }
    frame = SimpleNamespace(id=1, interval=300, debug=False, scenes=[parent_scene, child_scene])

    source = write_scene_nim(frame, parent_scene)

    assert (
        "import scenes/scene_03fe741a_75cf_4653_b77b_d2b42b7e0a94 "
        "as scene_03fe741a_75cf_4653_b77b_d2b42b7e0a94"
    ) in source


def test_write_scene_plugin_nim_exports_runtime_channel_binder():
    source = write_scene_plugin_nim({"id": "demo-scene", "name": "Demo"})

    assert "import frameos/channels" in source
    assert "proc bindCompiledPluginRuntimeChannels*(hooks: ptr CompiledRuntimeHooks)" in source
    assert "bindCompiledRuntimeHooks(hooks)" in source
    assert 'id: "demo-scene".SceneId' in source
