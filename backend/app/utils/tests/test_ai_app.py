from app.utils.ai_app import _build_app_edit_system_prompt, _build_app_user_prompt


def test_build_app_user_prompt_includes_js_reference_for_js_apps():
    prompt = _build_app_user_prompt(
        prompt="Add a render image output",
        sources={"config.json": "{}", "app.ts": "export function get(): string { return 'ok' }"},
        app_name="JS Text",
        app_keyword="data/jsText",
        scene_id="scene-1",
        node_id="node-1",
    )

    assert "FrameOS JavaScript app API reference:" in prompt
    assert "frameos.image" in prompt
    assert "frameos.assets.writeText" in prompt
    assert "interface Config" in prompt
    assert "# app.ts" in prompt


def test_build_app_user_prompt_omits_js_reference_for_nim_apps():
    prompt = _build_app_user_prompt(
        prompt="Explain this app",
        sources={"config.json": "{}", "app.nim": "discard"},
        app_name="If Else",
        app_keyword="logic/ifElse",
        scene_id="scene-1",
        node_id="node-1",
    )

    assert "FrameOS JavaScript app API reference:" not in prompt
    assert "# app.nim" in prompt


def test_build_app_edit_system_prompt_preserves_js_runtime():
    system_prompt = _build_app_edit_system_prompt({"config.json": "{}", "app.ts": "export function get() {}"})

    assert "Do not rewrite JavaScript or TypeScript apps into Nim" in system_prompt
    assert "QuickJS runtime" in system_prompt
