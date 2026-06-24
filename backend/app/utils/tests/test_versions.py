from pathlib import Path

from app.utils import versions


def test_get_versions_reflects_file_changes(monkeypatch, tmp_path: Path):
    versions_path = tmp_path / "versions.json"
    monkeypatch.setattr(versions, "VERSIONS_PATH", versions_path)

    versions_path.write_text('{"frameos":"2026.6.7+old","agent":"2026.6.7+old"}\n', encoding="utf-8")
    assert versions.current_frameos_version() == "2026.6.7"
    assert versions.current_remote_version() == "2026.6.7"
    assert versions.current_agent_version() == "2026.6.7"

    versions_path.write_text('{"frameos":"2026.6.8+new","remote":"2026.6.8+new"}\n', encoding="utf-8")
    assert versions.current_frameos_version() == "2026.6.8"
    assert versions.current_remote_version() == "2026.6.8"
    assert versions.current_agent_version() == "2026.6.8"
