from app.codegen.app_loader_nim import write_js_app_nim


def test_write_js_app_nim_supports_tsx_sources(tmp_path):
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

    source = write_js_app_nim(str(tmp_path))

    assert 'staticRead("./app.tsx")' in source
