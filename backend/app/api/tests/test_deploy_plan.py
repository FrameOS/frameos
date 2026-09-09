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
            captured_frames.append((frame.name, frame.scaling_mode))

        async def plan(self, mode: str):
            return type("Plan", (), {"to_dict": lambda self: {"mode": mode, "ok": True}})()

    monkeypatch.setattr("app.api.frames.find_nim_v2", lambda: "/usr/bin/nim")
    monkeypatch.setattr("app.api.frames.FrameDeployer", FakeDeployer)
    monkeypatch.setattr("app.api.frames.FrameDeployWorkflow", FakeWorkflow)

    response = await async_client.post(
        f"/api/frames/{frame.id}/deploy_plan",
        json={"name": "Preview Name", "scaling_mode": "stretch"},
    )

    assert response.status_code == 200
    assert response.json() == {"plan": {"mode": "combined", "ok": True}}
    assert captured_frames == [("Preview Name", "stretch")]


@pytest.mark.asyncio
async def test_get_deploy_plan_does_not_persist_the_detected_mode(
    async_client,
    db,
    monkeypatch: pytest.MonkeyPatch,
):
    """Opening the deploy drawer is a read: the workflow runs against a
    detached stand-in with persistence off, so a target whose distro differs
    from the row's mode changes the plan, never the frame."""
    frame = Frame(
        project_id=async_client.project_id,
        name="PlanFrame",
        mode="buildroot",
        frame_host="localhost",
        frame_port=8787,
        frame_access_key="key",
        frame_access="private",
        ssh_user="root",
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
        buildroot={"platform": "raspberry-pi-64"},
        scaling_mode="contain",
        rotate=0,
        assets_path="/srv/assets",
        save_assets=True,
        upload_fonts="",
    )
    db.add(frame)
    db.commit()
    db.refresh(frame)
    seen: list[dict] = []

    class FakeDeployer:
        def __init__(self, **_kwargs):
            pass

    class FakeWorkflow:
        def __init__(self, *, frame, persist_detected_mode=True, **_kwargs):
            seen.append({"is_row": isinstance(frame, Frame), "persist": persist_detected_mode})
            self.frame = frame
            self.pending_mode_change = None

        async def plan(self, mode: str):
            # What the real workflow does when the target turns out to be
            # Ubuntu: the stand-in is corrected so the plan is right.
            self.frame.mode = "rpios"
            self.frame.ssh_user = "pi"
            self.pending_mode_change = "Detected ubuntu: the next deploy switches it to rpios"
            return type("Plan", (), {"notes": [], "to_dict": lambda self: {"mode": mode, "notes": self.notes}})()

    monkeypatch.setattr("app.api.frames.find_nim_v2", lambda: "/usr/bin/nim")
    monkeypatch.setattr("app.api.frames.FrameDeployer", FakeDeployer)
    monkeypatch.setattr("app.api.frames.FrameDeployWorkflow", FakeWorkflow)

    response = await async_client.get(f"/api/frames/{frame.id}/deploy_plan?mode=full")

    assert response.status_code == 200, response.text
    assert response.json()["plan"]["notes"] == ["Detected ubuntu: the next deploy switches it to rpios"]
    assert seen == [{"is_row": False, "persist": False}]
    db.expire_all()
    row = db.get(Frame, frame.id)
    assert row.mode == "buildroot"
    assert row.ssh_user == "root"
