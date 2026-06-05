from __future__ import annotations

import pytest

from app.models.frame import Frame


@pytest.mark.asyncio
async def test_get_deploy_plan_returns_plan_without_execution(
    async_client,
    db,
    monkeypatch: pytest.MonkeyPatch,
):
    frame = Frame(
        project_id=async_client.project_id,
        name="PlanFrame",
        mode="rpios",
        frame_host="localhost",
        frame_port=8787,
        frame_access_key="key",
        frame_access="private",
        ssh_user="pi",
        ssh_port=22,
        server_host="localhost",
        server_port=8989,
        server_api_key="server-key",
        server_send_logs=True,
        status="uninitialized",
        interval=300,
        metrics_interval=60,
        scenes=[],
        apps=[],
        scaling_mode="contain",
        rotate=0,
        assets_path="/srv/assets",
        save_assets=True,
        upload_fonts="",
    )
    db.add(frame)
    db.commit()
    db.refresh(frame)
    events: list[str] = []

    class FakeDeployer:
        def __init__(self, **_kwargs):
            pass

    class FakeWorkflow:
        def __init__(self, **_kwargs):
            pass

        async def plan(self, mode: str):
            events.append(f"plan:{mode}")
            return type("Plan", (), {"to_dict": lambda self: {"mode": mode, "ok": True}})()

    monkeypatch.setattr("app.api.frames.find_nim_v2", lambda: "/usr/bin/nim")
    monkeypatch.setattr("app.api.frames.FrameDeployer", FakeDeployer)
    monkeypatch.setattr("app.api.frames.FrameDeployWorkflow", FakeWorkflow)

    response = await async_client.get(f"/api/frames/{frame.id}/deploy_plan")

    assert response.status_code == 200
    assert response.json() == {"plan": {"mode": "combined", "ok": True}}
    assert events == ["plan:combined"]


@pytest.mark.asyncio
async def test_post_deploy_plan_uses_preview_frame_values(
    async_client,
    db,
    monkeypatch: pytest.MonkeyPatch,
):
    frame = Frame(
        project_id=async_client.project_id,
        name="PlanFrame",
        mode="rpios",
        frame_host="localhost",
        frame_port=8787,
        frame_access_key="key",
        frame_access="private",
        ssh_user="pi",
        ssh_port=22,
        server_host="localhost",
        server_port=8989,
        server_api_key="server-key",
        server_send_logs=True,
        status="uninitialized",
        interval=300,
        metrics_interval=60,
        scenes=[],
        apps=[],
        scaling_mode="contain",
        rotate=0,
        assets_path="/srv/assets",
        save_assets=True,
        upload_fonts="",
    )
    db.add(frame)
    db.commit()
    db.refresh(frame)
    captured_frames: list[tuple[str, str | None]] = []

    class FakeDeployer:
        def __init__(self, **_kwargs):
            pass

    class FakeWorkflow:
        def __init__(self, *, frame, **_kwargs):
            captured_frames.append((frame.name, frame.image_engine))

        async def plan(self, mode: str):
            return type("Plan", (), {"to_dict": lambda self: {"mode": mode, "ok": True}})()

    monkeypatch.setattr("app.api.frames.find_nim_v2", lambda: "/usr/bin/nim")
    monkeypatch.setattr("app.api.frames.FrameDeployer", FakeDeployer)
    monkeypatch.setattr("app.api.frames.FrameDeployWorkflow", FakeWorkflow)

    response = await async_client.post(
        f"/api/frames/{frame.id}/deploy_plan",
        json={"name": "Preview Name", "image_engine": "imagemagick"},
    )

    assert response.status_code == 200
    assert response.json() == {"plan": {"mode": "combined", "ok": True}}
    assert captured_frames == [("Preview Name", "imagemagick")]
