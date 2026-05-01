import pytest

from app.codegen.app_loader_nim import write_app_loader_nim


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
