import json

import pytest

from app.utils import public_tls
from app.utils.public_tls import PublicTlsError, resolve_public_tls, shell_exports


def _write_options(tmp_path, **options):
    path = tmp_path / "options.json"
    path.write_text(json.dumps(options))
    return str(path)


def _ssl_dir(tmp_path, monkeypatch, *names):
    ssl_dir = tmp_path / "ssl"
    ssl_dir.mkdir()
    for name in names:
        (ssl_dir / name).write_text("-----BEGIN-----")
    monkeypatch.setattr(public_tls, "ADDON_SSL_DIR", str(ssl_dir))
    return ssl_dir


def test_plain_http_when_nothing_is_configured(tmp_path):
    assert resolve_public_tls({}, options_path=str(tmp_path / "missing.json")) is None
    # An add-on with the option off serves HTTP too.
    options = _write_options(tmp_path, ssl=False, certfile="fullchain.pem", keyfile="privkey.pem")
    assert resolve_public_tls({"HASSIO_TOKEN": "t"}, options_path=options) is None
    assert shell_exports(None) == ""


def test_addon_option_names_files_in_the_ssl_folder(tmp_path, monkeypatch):
    ssl_dir = _ssl_dir(tmp_path, monkeypatch, "fullchain.pem", "privkey.pem")
    options = _write_options(tmp_path, ssl=True, certfile="fullchain.pem", keyfile="privkey.pem")

    tls = resolve_public_tls({"HASSIO_TOKEN": "t"}, options_path=options)

    assert tls is not None
    assert tls.source == "addon"
    assert tls.certfile == str(ssl_dir / "fullchain.pem")
    assert tls.keyfile == str(ssl_dir / "privkey.pem")
    exports = shell_exports(tls)
    assert f"export FRAMEOS_SSL_CERTFILE={ssl_dir / 'fullchain.pem'}" in exports
    assert f"export FRAMEOS_SSL_KEYFILE={ssl_dir / 'privkey.pem'}" in exports
    assert "export FRAMEOS_PUBLIC_SCHEME=https" in exports


def test_addon_options_default_to_the_lets_encrypt_names(tmp_path, monkeypatch):
    ssl_dir = _ssl_dir(tmp_path, monkeypatch, "fullchain.pem", "privkey.pem")
    options = _write_options(tmp_path, ssl=True, certfile="", keyfile=None)

    tls = resolve_public_tls({"HASSIO_TOKEN": "t"}, options_path=options)

    assert tls is not None
    assert tls.certfile == str(ssl_dir / "fullchain.pem")
    assert tls.keyfile == str(ssl_dir / "privkey.pem")


def test_addon_option_without_hassio_is_ignored(tmp_path, monkeypatch):
    # A stray options.json in a plain container is not a Home Assistant add-on.
    _ssl_dir(tmp_path, monkeypatch, "fullchain.pem", "privkey.pem")
    options = _write_options(tmp_path, ssl=True)
    assert resolve_public_tls({}, options_path=options) is None


def test_addon_ssl_on_with_a_missing_certificate_refuses_to_start(tmp_path, monkeypatch):
    _ssl_dir(tmp_path, monkeypatch, "fullchain.pem")  # no privkey.pem
    options = _write_options(tmp_path, ssl=True)

    with pytest.raises(PublicTlsError, match=r"keyfile .*privkey\.pem does not exist.*turn the ssl option off"):
        resolve_public_tls({"HASSIO_TOKEN": "t"}, options_path=options)


@pytest.mark.parametrize("name", ["../data/options.json", "/etc/passwd", ".", "sub/../../x"])
def test_addon_option_may_not_leave_the_ssl_folder(tmp_path, monkeypatch, name):
    _ssl_dir(tmp_path, monkeypatch, "fullchain.pem", "privkey.pem")
    options = _write_options(tmp_path, ssl=True, certfile=name)

    with pytest.raises(PublicTlsError, match="certfile"):
        resolve_public_tls({"HASSIO_TOKEN": "t"}, options_path=options)


def test_addon_option_may_name_a_subfolder(tmp_path, monkeypatch):
    ssl_dir = _ssl_dir(tmp_path, monkeypatch)
    (ssl_dir / "frameos").mkdir()
    (ssl_dir / "frameos" / "cert.pem").write_text("c")
    (ssl_dir / "frameos" / "key.pem").write_text("k")
    options = _write_options(tmp_path, ssl=True, certfile="frameos/cert.pem", keyfile="frameos/key.pem")

    tls = resolve_public_tls({"HASSIO_TOKEN": "t"}, options_path=options)

    assert tls is not None
    assert tls.certfile == str(ssl_dir / "frameos" / "cert.pem")


def test_env_names_the_files_and_wins_over_the_addon_options(tmp_path, monkeypatch):
    _ssl_dir(tmp_path, monkeypatch, "fullchain.pem", "privkey.pem")
    options = _write_options(tmp_path, ssl=True)
    cert = tmp_path / "my cert.pem"
    key = tmp_path / "key.pem"
    cert.write_text("c")
    key.write_text("k")

    tls = resolve_public_tls(
        {"HASSIO_TOKEN": "t", "FRAMEOS_SSL_CERTFILE": str(cert), "FRAMEOS_SSL_KEYFILE": str(key)},
        options_path=options,
    )

    assert tls is not None
    assert tls.source == "env"
    assert tls.certfile == str(cert)
    # Shell-quoted: the path has a space in it.
    assert f"export FRAMEOS_SSL_CERTFILE='{cert}'" in shell_exports(tls)


def test_env_needs_both_files(tmp_path):
    cert = tmp_path / "cert.pem"
    cert.write_text("c")
    with pytest.raises(PublicTlsError, match="both"):
        resolve_public_tls({"FRAMEOS_SSL_CERTFILE": str(cert)})
    with pytest.raises(PublicTlsError, match="does not exist"):
        resolve_public_tls({"FRAMEOS_SSL_CERTFILE": str(cert), "FRAMEOS_SSL_KEYFILE": str(tmp_path / "nope.pem")})


def test_main_prints_exports_and_fails_loudly(tmp_path, monkeypatch, capsys):
    cert = tmp_path / "cert.pem"
    key = tmp_path / "key.pem"
    cert.write_text("c")
    key.write_text("k")
    monkeypatch.setenv("FRAMEOS_SSL_CERTFILE", str(cert))
    monkeypatch.setenv("FRAMEOS_SSL_KEYFILE", str(key))
    assert public_tls.main() == 0
    out, err = capsys.readouterr()
    assert "export FRAMEOS_PUBLIC_SCHEME=https" in out
    assert "HTTPS" in err

    monkeypatch.setenv("FRAMEOS_SSL_KEYFILE", str(tmp_path / "missing.pem"))
    assert public_tls.main() == 1
    out, err = capsys.readouterr()
    assert out == ""
    assert "cannot start" in err
