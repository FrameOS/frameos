from app.utils.build_environment import get_selected_build_environment_provider, selected_build_environment_provider


def test_selected_build_environment_defaults_to_docker():
    assert selected_build_environment_provider({}) == "docker"


def test_selected_build_environment_defaults_to_none_in_hassio(monkeypatch):
    monkeypatch.setenv("HASSIO_RUN_MODE", "ingress")

    assert selected_build_environment_provider({}) == "none"
    assert get_selected_build_environment_provider(None) == "none"


def test_selected_build_environment_uses_explicit_provider():
    assert selected_build_environment_provider({"buildEnvironment": {"provider": "none"}}) == "none"
    assert selected_build_environment_provider({"buildEnvironment": {"provider": "docker"}}) == "docker"
    assert selected_build_environment_provider({"buildEnvironment": {"provider": "modal"}}) == "modal"


def test_selected_build_environment_infers_legacy_settings():
    assert selected_build_environment_provider({"modalSandbox": {"enabled": True}}) == "modal"
    assert selected_build_environment_provider({"buildHost": {"enabled": True}}) == "buildHost"


def test_selected_build_environment_explicit_provider_wins_over_legacy_flags():
    assert (
        selected_build_environment_provider(
            {
                "buildEnvironment": {"provider": "docker"},
                "modalSandbox": {"enabled": True},
                "buildHost": {"enabled": True},
            }
        )
        == "docker"
    )
