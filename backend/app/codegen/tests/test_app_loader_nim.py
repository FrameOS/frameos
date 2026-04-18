from app.codegen.app_loader_nim import write_js_app_nim


def test_write_js_app_nim_hoists_static_read_to_const(tmp_path):
    app_dir = tmp_path / "jsImage"
    app_dir.mkdir()

    config = {
        "category": "data",
        "output": [{"type": "image"}],
        "fields": [
            {"name": "width", "type": "integer", "value": 320},
            {"name": "height", "type": "integer", "value": 240},
        ],
    }

    nim_code = write_js_app_nim(str(app_dir), config)

    assert 'const compiledJsSource = staticRead("./app.compiled.js")' in nim_code
    assert "source = compiledJsSource" in nim_code
    assert 'source = staticRead("./app.compiled.js")' not in nim_code
