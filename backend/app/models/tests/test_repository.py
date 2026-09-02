import json

import pytest
from app.models.repository import Repository


def _fake_client(payload: dict, calls: list):
    """httpx.AsyncClient as update_templates uses it: `.stream("GET", url)`
    yielding the repository JSON."""
    body = json.dumps(payload).encode()

    class FakeStream:
        headers = {"content-length": str(len(body))}

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        def raise_for_status(self):
            return None

        async def aiter_bytes(self):
            yield body

    class FakeClient:
        def __init__(self, **kwargs):
            calls.append(("init", kwargs))

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        def stream(self, method, url, **kwargs):
            calls.append((method, url))
            return FakeStream()

    return FakeClient

@pytest.mark.asyncio
async def test_repository_create(db, default_project):
    repo = Repository(project_id=default_project.id, name="TestRepo", url="http://example.com/repo")
    db.add(repo)
    db.commit()
    assert repo.id is not None


@pytest.mark.asyncio
async def test_repository_update_templates(db, default_project, monkeypatch):
    calls = []
    monkeypatch.setattr(
        "app.models.repository.httpx.AsyncClient",
        _fake_client(
            {
                "name": "My Repo",
                "description": "A sample repository",
                "templates": [{"title": "Template1"}],
            },
            calls,
        ),
    )

    repo = Repository(project_id=default_project.id, name="OldName", url="http://example.com/repo")
    db.add(repo)
    db.commit()

    await repo.update_templates()
    db.commit()

    assert repo.name == "My Repo"
    assert repo.description == "A sample repository"
    assert len(repo.templates) == 1

    assert calls == [("init", {"timeout": 10}), ("GET", "http://example.com/repo")]


@pytest.mark.asyncio
async def test_repository_resolves_relative_assets(db, default_project, monkeypatch):
    """"./" assets resolve against the index URL; a null image is not fatal."""
    monkeypatch.setattr(
        "app.models.repository.httpx.AsyncClient",
        _fake_client(
            {
                "templates": [
                    {"name": "Relative", "image": "./scenes/abc/image", "zip": "./scenes/abc/download"},
                    {"name": "Absolute", "image": "https://scenes.example.com/scenes/def/image"},
                    {"name": "No preview", "image": None},
                ],
            },
            [],
        ),
    )

    repo = Repository(
        project_id=default_project.id,
        name="Store",
        url="https://cloud.example.com/api/store/repository.json",
    )
    db.add(repo)
    db.commit()

    await repo.update_templates()
    db.commit()

    by_name = {template["name"]: template for template in repo.templates}
    assert by_name["Relative"]["image"] == "https://cloud.example.com/api/store/scenes/abc/image"
    assert by_name["Relative"]["zip"] == "https://cloud.example.com/api/store/scenes/abc/download"
    assert by_name["Absolute"]["image"] == "https://scenes.example.com/scenes/def/image"
    assert by_name["No preview"]["image"] is None
