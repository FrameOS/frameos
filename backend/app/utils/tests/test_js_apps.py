from app.utils.js_apps import validate_js_source


def test_validate_js_source_accepts_typescript_jsx():
    assert (
        validate_js_source(
            "app.tsx",
            'const view = <text>ok</text>; export function get() { return "ok" }',
        )
        == []
    )


def test_validate_js_source_reports_native_transform_location():
    errors = validate_js_source("app.ts", "export function get(app: any) { return ")

    assert errors
    assert errors[0]["line"] == 1
    assert errors[0]["column"] > 0
    assert "Unexpected" in errors[0]["error"]
