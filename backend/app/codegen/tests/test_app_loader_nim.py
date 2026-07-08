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
    assert 'of "nodeapp_custom": nodeapp_custom_loader.run(app, context)' in apps_nim
    assert "nodeapp_custom_loader.get(app, context)" not in apps_nim


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
    assert 'of "data/rstpSnapshot":\n    when defined(frameosEmbedded) or defined(frameosWasm):' in apps_nim
    assert "App 'data/rstpSnapshot' is not available on this build target" in apps_nim
