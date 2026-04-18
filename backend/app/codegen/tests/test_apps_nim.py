import json

from app.codegen.apps_nim import write_apps_nim


def test_write_apps_nim_skips_apps_without_generated_loader(tmp_path):
    apps_root = tmp_path / "frameos" / "src" / "apps"
    nim_app_dir = apps_root / "data" / "clock"
    nim_app_dir.mkdir(parents=True)
    (nim_app_dir / "config.json").write_text(
        json.dumps({"name": "Clock", "category": "data", "output": [{"name": "text", "type": "text"}]}),
        encoding="utf-8",
    )
    (nim_app_dir / "app_loader.nim").write_text("discard\n", encoding="utf-8")

    js_app_dir = apps_root / "data" / "jsText"
    js_app_dir.mkdir(parents=True)
    (js_app_dir / "config.json").write_text(
        json.dumps({"name": "JS Text", "category": "data", "output": [{"name": "text", "type": "text"}]}),
        encoding="utf-8",
    )

    nim_code = write_apps_nim(str(tmp_path / "frameos"))

    assert 'import apps/data/clock/app_loader as data_clock_loader' in nim_code
    assert 'import apps/data/jsText/app_loader as data_jsText_loader' not in nim_code
    assert 'of "data/clock": data_clock_loader.init(node, scene)' in nim_code
    assert 'of "data/jsText": data_jsText_loader.init(node, scene)' not in nim_code
