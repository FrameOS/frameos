import pytest

from app.utils import posthog


class FakePosthog:
    def __init__(self, project_api_key: str, host: str):
        self.project_api_key = project_api_key
        self.host = host


def _reset_posthog_state():
    posthog.posthog_projects.clear()
    posthog.posthog_client = None
    posthog.posthog_settings = {
        "enable_error_tracking": False,
        "enable_llm_analytics": False,
    }


@pytest.fixture(autouse=True)
def reset_posthog_state():
    _reset_posthog_state()
    yield
    _reset_posthog_state()


def test_project_posthog_clients_are_isolated(monkeypatch):
    monkeypatch.setattr(posthog, "Posthog", FakePosthog)

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


def test_project_posthog_cache_is_lru(monkeypatch):
    monkeypatch.setattr(posthog, "Posthog", FakePosthog)
    monkeypatch.setattr(posthog, "posthog_projects", posthog.LRUCache[int, posthog.ProjectPosthogState](2))

    for project_id in (1, 2):
        posthog.initialize_posthog(
            {
                "posthog": {
                    "backendApiKey": f"project-{project_id}",
                    "backendEnableErrorTracking": True,
                }
            },
            project_id=project_id,
        )

    assert posthog.get_posthog_client(1).project_api_key == "project-1"

    posthog.initialize_posthog(
        {
            "posthog": {
                "backendApiKey": "project-3",
                "backendEnableErrorTracking": True,
            }
        },
        project_id=3,
    )

    assert posthog.get_posthog_client(1).project_api_key == "project-1"
    assert posthog.get_posthog_client(2) is None
    assert posthog.get_posthog_client(3).project_api_key == "project-3"
    assert len(posthog.posthog_projects) == 2
