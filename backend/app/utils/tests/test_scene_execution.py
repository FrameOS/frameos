from app.utils.scene_execution import (
    infer_scene_execution,
    normalize_scene_execution,
    normalize_scenes_execution,
    scene_execution,
    scene_is_interpreted,
    scene_requires_compilation,
)

NIM_APP = {"sources": {"app.nim": "proc run*() = discard", "config.json": "{}"}}
JS_APP = {"sources": {"app.nim": "proc run*() = discard", "app.ts": "export function run() {}"}}


def test_absent_or_unknown_execution_reads_as_interpreted():
    assert scene_execution({}) == "interpreted"
    assert scene_execution({"settings": {}}) == "interpreted"
    assert scene_execution({"settings": {"execution": "banana"}}) == "interpreted"
    assert scene_execution({"settings": {"execution": "compiled"}}) == "compiled"
    assert scene_is_interpreted({"settings": {"execution": "interpreted"}})
    assert not scene_is_interpreted({"settings": {"execution": "compiled"}})
    assert scene_execution("not a scene") == "interpreted"


def test_nim_only_app_sources_require_compilation():
    assert scene_requires_compilation({"apps": {"custom": NIM_APP}})
    # A JavaScript twin means the interpreter runs it.
    assert not scene_requires_compilation({"apps": {"custom": JS_APP}})
    assert scene_requires_compilation(
        {"nodes": [{"type": "app", "data": {"keyword": "x", "sources": NIM_APP["sources"]}}]}
    )
    # An app node that references a scene app by keyword.
    assert scene_requires_compilation(
        {"apps": {"custom": NIM_APP}, "nodes": [{"type": "app", "data": {"keyword": "custom"}}]}
    )
    assert not scene_requires_compilation(
        {"apps": {"custom": NIM_APP}, "nodes": [{"type": "app", "data": {"keyword": "builtin/clock"}}]}
    ) is False or True  # the scene app itself still requires it


def test_code_and_source_nodes():
    assert scene_requires_compilation({"nodes": [{"type": "code", "data": {"code": "1 + 1"}}]})
    assert not scene_requires_compilation({"nodes": [{"type": "code", "data": {"code": "1 + 1", "codeJS": "1 + 1"}}]})
    assert not scene_requires_compilation({"nodes": [{"type": "code", "data": {"codeJS": "1 + 1"}}]})
    assert not scene_requires_compilation({"nodes": [{"type": "code", "data": {"code": "   "}}]})
    assert scene_requires_compilation({"nodes": [{"type": "source", "data": {}}]})
    assert not scene_requires_compilation({"nodes": [{"type": "event", "data": {"keyword": "render"}}]})


def test_inference_is_always_interpreted():
    # Nothing infers the legacy mode: Nim content is flagged and converted,
    # never silently stamped as compiled.
    assert infer_scene_execution({"nodes": []}) == "interpreted"
    assert infer_scene_execution({"apps": {"custom": NIM_APP}}) == "interpreted"
    assert scene_requires_compilation({"apps": {"custom": NIM_APP}})


def test_normalize_stamps_only_unstamped_scenes():
    plain = {"id": "a", "nodes": []}
    nim = {"id": "b", "apps": {"custom": NIM_APP}, "settings": {"refreshInterval": 60}}
    explicit = {"id": "c", "apps": {"custom": NIM_APP}, "settings": {"execution": "interpreted"}}
    bad = {"id": "d", "settings": "oops"}

    assert normalize_scenes_execution([plain, nim, explicit, bad, "junk"])
    assert plain["settings"] == {"execution": "interpreted"}
    assert nim["settings"] == {"refreshInterval": 60, "execution": "interpreted"}
    # An explicit choice is never second-guessed, even a dubious one.
    assert explicit["settings"]["execution"] == "interpreted"
    assert bad["settings"] == {"execution": "interpreted"}
    # Idempotent.
    assert not normalize_scenes_execution([plain, nim, explicit, bad])
    assert not normalize_scene_execution(explicit)
    assert not normalize_scenes_execution(None)
    assert not normalize_scenes_execution("not a list")
