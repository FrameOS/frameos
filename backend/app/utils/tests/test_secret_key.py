import os
import stat

from app import config as app_config
from app.config import ProductionConfig, resolve_secret_key, secret_key_file_path


def test_environment_secret_key_wins(monkeypatch, tmp_path):
    monkeypatch.setenv("SECRET_KEY", "from-env")
    assert resolve_secret_key(str(tmp_path / "secret_key")) == ("from-env", "env")
    assert not (tmp_path / "secret_key").exists()


def test_generated_secret_key_is_persisted_once_and_shared(monkeypatch, tmp_path):
    monkeypatch.delenv("SECRET_KEY", raising=False)
    path = tmp_path / "db" / "secret_key"

    key, source = resolve_secret_key(str(path))
    assert source == "generated"
    assert len(key) >= 32
    assert path.read_text().strip() == key
    assert stat.S_IMODE(path.stat().st_mode) == 0o600

    # A second process (the worker next to the web server) reads the same key.
    assert resolve_secret_key(str(path)) == (key, "file")


def test_unwritable_location_falls_back_to_a_process_local_key(monkeypatch, tmp_path, capsys):
    monkeypatch.delenv("SECRET_KEY", raising=False)
    missing_parent = tmp_path / "file-not-dir"
    missing_parent.write_text("x")

    key, source = resolve_secret_key(str(missing_parent / "secret_key"))
    assert source == "generated"
    assert key
    assert "Could not persist SECRET_KEY" in capsys.readouterr().out


def test_secret_key_file_lives_next_to_the_sqlite_database(monkeypatch):
    monkeypatch.delenv("SECRET_KEY_FILE", raising=False)
    monkeypatch.delenv("HASSIO_TOKEN", raising=False)
    monkeypatch.setenv("DATABASE_URL", "sqlite:////srv/frameos/db/frameos.db")
    assert secret_key_file_path() == "/srv/frameos/db/secret_key"

    monkeypatch.delenv("DATABASE_URL", raising=False)
    assert secret_key_file_path() == os.path.join("..", "db", "secret_key")

    monkeypatch.setenv("SECRET_KEY_FILE", "/etc/frameos/key")
    assert secret_key_file_path() == "/etc/frameos/key"


def test_production_config_warns_once_about_a_generated_key(monkeypatch, tmp_path, capsys):
    monkeypatch.delenv("SECRET_KEY", raising=False)
    monkeypatch.setenv("SECRET_KEY_FILE", str(tmp_path / "secret_key"))

    config = ProductionConfig()
    assert config.SECRET_KEY_SOURCE == "generated"
    assert config.SECRET_KEY == (tmp_path / "secret_key").read_text().strip()
    assert "SECRET_KEY is not set" in capsys.readouterr().out

    # The check is evaluated per process at runtime, not at class definition.
    monkeypatch.setenv("SECRET_KEY", "configured")
    config = ProductionConfig()
    assert (config.SECRET_KEY, config.SECRET_KEY_SOURCE) == ("configured", "env")
    assert "SECRET_KEY is not set" not in capsys.readouterr().out
    assert app_config.Config.SECRET_KEY == ""  # nothing baked in at import time
