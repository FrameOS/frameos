import pytest

from app.utils.js_apps import COMPILED_JS_APP_FILENAME, compile_js_app_sources, validate_js_source


def test_compile_js_app_sources_bundles_local_imports():
    compiled_sources = compile_js_app_sources(
        {
            "app.ts": "import { message } from './helper'; export function get() { return message }",
            "helper.ts": "export const message = 'hello from helper'",
        }
    )

    assert compiled_sources[COMPILED_JS_APP_FILENAME]
    assert "hello from helper" in compiled_sources[COMPILED_JS_APP_FILENAME]


def test_validate_js_source_returns_configuration_errors(monkeypatch):
    monkeypatch.setattr(
        "app.utils.js_apps._find_esbuild_module_path",
        lambda: (_ for _ in ()).throw(RuntimeError("esbuild missing")),
    )

    errors = validate_js_source("app.ts", "export function get() { return 'ok' }")

    assert errors == [{"line": 1, "column": 1, "error": "esbuild missing"}]


@pytest.mark.parametrize("filename", ["../escape.ts", "/tmp/escape.ts"])
def test_compile_js_app_sources_rejects_unsafe_filenames(filename, monkeypatch):
    monkeypatch.setattr("app.utils.js_apps.compile_js_app_dir", lambda *_args, **_kwargs: None)

    with pytest.raises(ValueError, match="Invalid JS source filename"):
        compile_js_app_sources(
            {
                "app.ts": "export function get() { return 'ok' }",
                filename: "export const ignored = true",
            }
        )
