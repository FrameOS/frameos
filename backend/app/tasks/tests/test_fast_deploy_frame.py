import importlib
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.tasks.fast_deploy_frame import frame_has_compiled_scenes, tls_settings_changed

fast_deploy_frame_module = importlib.import_module("app.tasks.fast_deploy_frame")


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


def test_frame_has_compiled_scenes_detects_compiled_and_interpreted_modes():
    frame = SimpleNamespace(
        scenes=[
            {"id": "compiled", "settings": {"execution": "compiled"}},
            {"id": "interpreted", "settings": {"execution": "interpreted"}},
        ]
    )
    assert frame_has_compiled_scenes(frame) is True

    interpreted_only = SimpleNamespace(scenes=[{"id": "only", "settings": {"execution": "interpreted"}}])
    assert frame_has_compiled_scenes(interpreted_only) is False


@pytest.mark.asyncio
async def test_fast_deploy_frame_task_does_not_require_local_nim(
    monkeypatch: pytest.MonkeyPatch,
):
    frame = SimpleNamespace(
        id=1,
        status="uninitialized",
        scenes=[],
        device="http.upload",
        gpio_buttons=[],
        https_proxy={},
        last_successful_deploy={
            "device": "http.upload",
            "gpio_buttons": [],
            "scenes": [],
            "frameos_version": "1.2.3",
            "compile_manifest": {"version": 1},
        },
    )
    frame.to_dict = lambda: {"id": frame.id}
    db = SimpleNamespace(get=lambda _model, _id: frame)
    redis = object()

    captured: dict[str, object] = {}

    class FakeDeployer:
        def __init__(self, *, db, redis, frame, nim_path, temp_dir):
            captured["nim_path"] = nim_path

        async def get_distro(self):
            return "raspios"

        async def _upload_frame_json(self, path: str):
            captured["frame_json_path"] = path

        async def _upload_scenes_json(self, path: str, gzip: bool = False):
            captured["scenes_json_path"] = path
            captured["scenes_json_gzip"] = gzip

        async def restart_service(self, _service_name: str):
            captured["restarted"] = True

    monkeypatch.setattr(fast_deploy_frame_module, "FrameDeployer", FakeDeployer)
    monkeypatch.setattr(fast_deploy_frame_module, "update_frame", AsyncMock())
    monkeypatch.setattr(fast_deploy_frame_module, "log", AsyncMock())
    monkeypatch.setattr(
        fast_deploy_frame_module,
        "_fetch_frame_http_bytes",
        AsyncMock(return_value=(200, b"OK", {})),
    )

    await fast_deploy_frame_module.fast_deploy_frame_task({"db": db, "redis": redis}, 1)

    assert captured["nim_path"] == ""
    assert captured["frame_json_path"] == "/srv/frameos/current/frame.json"
    assert captured["scenes_json_path"] == "/srv/frameos/current/scenes.json.gz"
    assert captured["scenes_json_gzip"] is True
    assert "restarted" not in captured
    assert frame.status == "starting"
    assert frame.last_successful_deploy["frameos_version"] == "1.2.3"
    assert frame.last_successful_deploy["compile_manifest"] == {"version": 1}


@pytest.mark.asyncio
async def test_fast_deploy_frame_task_refuses_frames_with_compiled_scenes(
    monkeypatch: pytest.MonkeyPatch,
):
    frame = SimpleNamespace(
        id=1,
        status="ready",
        scenes=[{"id": "compiled", "settings": {"execution": "compiled"}}],
        device="http.upload",
        gpio_buttons=[],
        https_proxy={},
        last_successful_deploy={
            "device": "http.upload",
            "gpio_buttons": [],
            "scenes": [],
            "frameos_version": "1.2.3",
            "compile_manifest": {"version": 1},
        },
    )
    frame.to_dict = lambda: {"id": frame.id}
    db = SimpleNamespace(get=lambda _model, _id: frame)
    redis = object()

    update_frame = AsyncMock()
    log = AsyncMock()

    class ForbiddenDeployer:
        def __init__(self, **_kwargs):
            raise AssertionError("FrameDeployer should not be constructed for blocked fast deploys")

    monkeypatch.setattr(fast_deploy_frame_module, "FrameDeployer", ForbiddenDeployer)
    monkeypatch.setattr(fast_deploy_frame_module, "update_frame", update_frame)
    monkeypatch.setattr(fast_deploy_frame_module, "log", log)

    await fast_deploy_frame_module.fast_deploy_frame_task({"db": db, "redis": redis}, 1)

    update_frame.assert_not_awaited()
    log.assert_awaited_once()
    assert log.await_args.args[3] == "stderr"
    assert "compiled scenes" in log.await_args.args[4]
    assert frame.status == "ready"


@pytest.mark.asyncio
async def test_fast_deploy_frame_task_refuses_driver_changes(
    monkeypatch: pytest.MonkeyPatch,
):
    frame = SimpleNamespace(
        id=1,
        status="ready",
        scenes=[],
        device="framebuffer",
        gpio_buttons=[],
        https_proxy={},
        last_successful_deploy={
            "device": "http.upload",
            "gpio_buttons": [],
            "scenes": [],
            "frameos_version": "1.2.3",
            "compile_manifest": {"version": 1},
        },
    )
    frame.to_dict = lambda: {"id": frame.id}
    db = SimpleNamespace(get=lambda _model, _id: frame)
    redis = object()

    update_frame = AsyncMock()
    log = AsyncMock()

    class ForbiddenDeployer:
        def __init__(self, **_kwargs):
            raise AssertionError("FrameDeployer should not be constructed for blocked fast deploys")

    monkeypatch.setattr(fast_deploy_frame_module, "FrameDeployer", ForbiddenDeployer)
    monkeypatch.setattr(fast_deploy_frame_module, "update_frame", update_frame)
    monkeypatch.setattr(fast_deploy_frame_module, "log", log)

    await fast_deploy_frame_module.fast_deploy_frame_task({"db": db, "redis": redis}, 1)

    update_frame.assert_not_awaited()
    log.assert_awaited_once()
    assert log.await_args.args[3] == "stderr"
    assert "compiled drivers" in log.await_args.args[4]
    assert frame.status == "ready"
