from types import SimpleNamespace

from app.tasks.fast_deploy_frame import tls_settings_changed


def test_tls_settings_changed_returns_false_without_previous_deploy():
    frame = SimpleNamespace(
        last_successful_deploy=None,
        https_proxy={
            "enable": False,
            "port": 8443,
            "expose_only_port": False,
            "certs": {
                "server": "cert-a",
                "server_key": "key-a",
                "client_ca": "ca-a",
            },
        },
    )

    assert tls_settings_changed(frame) is False


def test_tls_settings_changed_returns_true_when_tls_field_changes():
    frame = SimpleNamespace(
        last_successful_deploy={
            "https_proxy": {
                "enable": True,
                "port": 8443,
                "expose_only_port": True,
                "certs": {
                    "server": "cert-a",
                    "server_key": "key-a",
                    "client_ca": "ca-a",
                },
            }
        },
        https_proxy={
            "enable": True,
            "port": 9443,
            "expose_only_port": True,
            "certs": {
                "server": "cert-a",
                "server_key": "key-a",
                "client_ca": "ca-a",
            },
        },
    )

    assert tls_settings_changed(frame) is True


def test_tls_settings_changed_returns_false_when_tls_fields_match_previous_deploy():
    frame = SimpleNamespace(
        last_successful_deploy={
            "https_proxy": {
                "enable": True,
                "port": 8443,
                "expose_only_port": True,
                "certs": {
                    "server": "cert-a",
                    "server_key": "key-a",
                    "client_ca": "ca-a",
                },
            }
        },
        https_proxy={
            "enable": True,
            "port": 8443,
            "expose_only_port": True,
            "certs": {
                "server": "cert-a",
                "server_key": "key-a",
                "client_ca": "ca-a",
            },
        },
    )

    assert tls_settings_changed(frame) is False
