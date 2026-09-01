import pytest

from app.codegen.app_loader_nim import write_app_loader_nim
from app.codegen.apps_nim import write_apps_nim


def test_write_app_loader_nim_requires_nim_source(tmp_path):
    (tmp_path / "config.json").write_text(
        """
{
  "name": "TSX App",
  "category": "data",
  "fields": [],
  "output": [{"name": "text", "type": "text"}]
}
""",
        encoding="utf-8",
    )
    (tmp_path / "app.tsx").write_text(
        'const view = <text>ok</text>; export function get() { return "ok" }\n',
        encoding="utf-8",
    )

    with pytest.raises(FileNotFoundError, match="Nim app source not found"):
        write_app_loader_nim(str(tmp_path))


def test_native_run_app_with_legacy_category_is_not_registered_as_data_app(tmp_path):
    app_dir = tmp_path / "src" / "apps" / "nodeapp_custom"
    app_dir.mkdir(parents=True)
    (app_dir / "config.json").write_text(
        """
{
  "name": "Custom logic",
  "category": "boilerplate",
  "fields": [{"markdown": "scene.state{\\"result\\"}.getStr"}]
}
""",
        encoding="utf-8",
    )
    (app_dir / "app.nim").write_text(
        """
import frameos/types

type
  AppConfig* = object
  App* = ref object of AppRoot
    appConfig*: AppConfig

proc run*(self: App, context: ExecutionContext) =
  discard
""",
        encoding="utf-8",
    )

    app_loader_nim = write_app_loader_nim(str(app_dir))
    (app_dir / "app_loader.nim").write_text(app_loader_nim, encoding="utf-8")
    apps_nim = write_apps_nim(str(tmp_path))

    assert "proc run*(self: AppRoot, context: ExecutionContext)" in app_loader_nim
    assert "proc get*(self: AppRoot, context: ExecutionContext)" not in app_loader_nim
    assert "runProc: nodeapp_custom_loader.run" in apps_nim
    assert "getProc: nil" in apps_nim
    assert "nodeapp_custom_loader.get" not in apps_nim


def test_embedded_unavailable_apps_are_guarded_in_registry(tmp_path):
    app_dir = tmp_path / "src" / "apps" / "data" / "rstpSnapshot"
    app_dir.mkdir(parents=True)
    (app_dir / "config.json").write_text(
        """
{
  "name": "RTSP Snapshot",
  "category": "data",
  "fields": []
}
""",
        encoding="utf-8",
    )

    apps_nim = write_apps_nim(str(tmp_path))

    assert "when not defined(frameosEmbedded) and not defined(frameosWasm):" in apps_nim
    assert "  import apps/data/rstpSnapshot/app_loader as data_rstpSnapshot_loader" in apps_nim

    # The registry is built twice: the embedded/wasm table leaves the host-only
    # app out entirely, the host table carries it, and the keyword still gets
    # the "not available on this build target" answer rather than "unknown".
    embedded_table, host_table = apps_nim.split("else:\n  const appEntries = [")
    assert 'AppEntry(keyword: "data/rstpSnapshot"' not in embedded_table
    assert 'AppEntry(keyword: "data/rstpSnapshot"' in host_table
    assert 'const hostOnlyApps = ["data/rstpSnapshot"]' in apps_nim
    assert "App '\" & keyword & \"' is not available on this build target" in apps_nim


def _write_capability_app(tmp_path, keyword, config_json):
    app_dir = tmp_path / "src" / "apps" / keyword
    app_dir.mkdir(parents=True)
    (app_dir / "config.json").write_text(config_json, encoding="utf-8")
    (app_dir / "app.nim").write_text(
        """
import frameos/types

type
  AppConfig* = object
  App* = ref object of AppRoot
    appConfig*: AppConfig

proc get*(self: App, context: ExecutionContext): Value =
  discard
""",
        encoding="utf-8",
    )
    return app_dir


def test_port_capabilities_reach_the_registry(tmp_path):
    """Declared port capabilities become the planner's AppCapabilities literals."""
    _write_capability_app(
        tmp_path,
        "render/image",
        """
{
  "name": "Render Image",
  "category": "render",
  "fields": [
    {"name": "inputImage", "type": "image"},
    {"name": "placement", "type": "select", "value": "cover",
     "capabilities": {"providesTarget": {
        "fitFrom": "placement",
        "fits": ["cover", "contain"],
        "requireStatic": {"blendMode": ["normal", "overwrite"]},
        "requireUnset": ["inputImage"],
        "ownedTargetExcludes": [{"placement": "contain", "blendMode": "overwrite"}]
     }}},
    {"name": "blendMode", "type": "select", "value": "normal"}
  ],
  "output": [{"name": "image", "type": "image"}]
}
""",
    )

    apps_nim = write_apps_nim(str(tmp_path))

    assert "import frameos/app_capabilities" in apps_nim
    assert "proc appCapabilities*(keyword: string): AppCapabilities =" in apps_nim
    assert 'ProvidesTargetSpec(input: "placement", fitFrom: "placement"' in apps_nim
    assert 'fits: @["cover", "contain"]' in apps_nim
    assert 'FieldConstraint(field: "blendMode", allowed: @["normal", "overwrite"])' in apps_nim
    assert 'requireUnset: @["inputImage"]' in apps_nim
    assert (
        'ownedTargetExcludes: @[@[FieldMatch(field: "placement", value: "contain"), '
        'FieldMatch(field: "blendMode", value: "overwrite")]]'
    ) in apps_nim
    # Every field a spec mentions carries its config.json default, so the
    # planner can tell "unset" from "explicitly set to the default".
    assert 'FieldMatch(field: "placement", value: "cover")' in apps_nim
    assert 'FieldMatch(field: "blendMode", value: "normal")' in apps_nim


def test_output_capabilities_and_the_materialized_default(tmp_path):
    _write_capability_app(
        tmp_path,
        "data/downloadImage",
        """
{
  "name": "Download Image",
  "category": "data",
  "fields": [],
  "output": [{"name": "image", "type": "image",
              "capabilities": {"intoTarget": {}}}]
}
""",
    )
    _write_capability_app(
        tmp_path,
        "render/opacity",
        """
{
  "name": "Opacity",
  "category": "render",
  "fields": [{"name": "image", "type": "image"}],
  "output": [{"name": "image", "type": "image",
              "capabilities": {"forwardsTarget": {"input": "image"}}}]
}
""",
    )
    # An app that declares nothing must not appear at all: absent means
    # materialized, the floor every edge supports.
    _write_capability_app(
        tmp_path,
        "data/clock",
        """
{
  "name": "Clock",
  "category": "data",
  "fields": [],
  "output": [{"name": "time", "type": "string"}]
}
""",
    )

    apps_nim = write_apps_nim(str(tmp_path))

    assert 'IntoTargetSpec(output: "image", fits: @["cover", "contain", "stretch"]' in apps_nim
    assert 'ForwardsTargetSpec(output: "image", input: "image"' in apps_nim
    assert "  else: NoAppCapabilities" in apps_nim

    capabilities_section = apps_nim.split("proc appCapabilities*")[1]
    assert '"data/clock"' not in capabilities_section


def test_byte_iter_ports_convert_at_the_compiled_scene_boundary(tmp_path):
    """A compiled scene is statically typed and has no planner to negotiate with.

    An app declaring `byteIter` hands out (or takes) a Spool, so the generated
    scene has to convert at the boundary — otherwise the app's real signature
    and the type the codegen derived from config.json disagree, and the scene
    fails to compile. That is exactly how this broke: `data/downloadUrl` started
    returning a Spool and every compiled scene using it stopped building.
    """
    from app.codegen.scene_nim import app_output_is_byte_iter, declares_byte_iter

    producer = {"output": [{"name": "result", "type": "string",
                            "capabilities": {"byteIter": {}}}]}
    assert app_output_is_byte_iter(producer)
    assert not app_output_is_byte_iter({"output": [{"name": "result", "type": "string"}]})
    assert not app_output_is_byte_iter({})
    assert not app_output_is_byte_iter({"output": []})

    assert declares_byte_iter({"name": "ical", "capabilities": {"byteIter": {}}})
    assert not declares_byte_iter({"name": "ical"})
    assert not declares_byte_iter({"name": "ical", "capabilities": {"intoTarget": {}}})
    assert not declares_byte_iter(None)


def test_shipped_byte_iter_apps_stay_declared():
    """The declaration is what keeps the two codegens agreeing, so pin it.

    `icalJson.ical` is generated as a Spool by the app loader; `downloadUrl`'s
    output is one. If either declaration is dropped, the app loader and the
    scene codegen disagree about the type and compiled scenes break — which no
    unit test would otherwise notice.
    """
    import json
    from pathlib import Path
    from app.codegen.scene_nim import app_output_is_byte_iter, declares_byte_iter

    apps = Path(__file__).resolve().parents[4] / "frameos" / "src" / "apps"

    ical = json.loads((apps / "data" / "icalJson" / "config.json").read_text())
    ical_field = next(f for f in ical["fields"] if f.get("name") == "ical")
    assert declares_byte_iter(ical_field), "icalJson.ical must declare byteIter"

    download = json.loads((apps / "data" / "downloadUrl" / "config.json").read_text())
    assert app_output_is_byte_iter(download), "downloadUrl's output must declare byteIter"
