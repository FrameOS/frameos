from app.utils import posthog


class FakePosthog:
    def __init__(self, project_api_key: str, host: str):
        self.project_api_key = project_api_key
        self.host = host


def test_project_posthog_clients_are_isolated(monkeypatch):
    monkeypatch.setattr(posthog, "Posthog", FakePosthog)
    posthog.posthog_clients_by_project.clear()
    posthog.posthog_settings_by_project.clear()
    posthog.posthog_client = None
    posthog.posthog_settings = {
        "enable_error_tracking": False,
        "enable_llm_analytics": False,
    }

    posthog.initialize_posthog(
        {
            "posthog": {
                "backendApiKey": "project-one",
                "backendHost": "https://one.example",
                "backendEnableLlmAnalytics": True,
            }
        },
        project_id=1,
    )
    posthog.initialize_posthog(
        {
            "posthog": {
                "backendApiKey": "project-two",
                "backendHost": "https://two.example",
                "backendEnableErrorTracking": True,
                "backendEnableLlmAnalytics": False,
            }
        },
        project_id=2,
    )

    assert posthog.get_posthog_client(1).project_api_key == "project-one"
    assert posthog.get_posthog_client(2).project_api_key == "project-two"
    assert posthog.llm_analytics_enabled(1) is True
    assert posthog.llm_analytics_enabled(2) is False

    posthog.initialize_posthog({}, project_id=1)

    assert posthog.get_posthog_client(1) is None
    assert posthog.get_posthog_client(2).project_api_key == "project-two"
