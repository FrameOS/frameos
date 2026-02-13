from types import SimpleNamespace

from app.tasks.fast_deploy_frame import tls_settings_changed


def test_tls_settings_changed_returns_false_without_previous_deploy():
    frame = SimpleNamespace(
        last_successful_deploy=None,
        enable_tls=False,
        tls_port=8443,
        expose_only_tls_port=False,
        tls_server_cert="cert-a",
        tls_server_key="key-a",
        tls_client_ca_cert="ca-a",
    )

    assert tls_settings_changed(frame) is False


def test_tls_settings_changed_returns_true_when_tls_field_changes():
    frame = SimpleNamespace(
        last_successful_deploy={
            "enable_tls": True,
            "tls_port": 8443,
            "expose_only_tls_port": True,
            "tls_server_cert": "cert-a",
            "tls_server_key": "key-a",
            "tls_client_ca_cert": "ca-a",
        },
        enable_tls=True,
        tls_port=9443,
        expose_only_tls_port=True,
        tls_server_cert="cert-a",
        tls_server_key="key-a",
        tls_client_ca_cert="ca-a",
    )

    assert tls_settings_changed(frame) is True


def test_tls_settings_changed_returns_false_when_tls_fields_match_previous_deploy():
    frame = SimpleNamespace(
        last_successful_deploy={
            "enable_tls": True,
            "tls_port": 8443,
            "expose_only_tls_port": True,
            "tls_server_cert": "cert-a",
            "tls_server_key": "key-a",
            "tls_client_ca_cert": "ca-a",
        },
        enable_tls=True,
        tls_port=8443,
        expose_only_tls_port=True,
        tls_server_cert="cert-a",
        tls_server_key="key-a",
        tls_client_ca_cert="ca-a",
    )

    assert tls_settings_changed(frame) is False
