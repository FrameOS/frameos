from __future__ import annotations

import contextlib
import json
import os
import shutil
import socket
import subprocess
import threading
import time
from pathlib import Path
from typing import Iterator

import pytest
import uvicorn

from app.fastapi import app
from app.models.frame import Frame, get_frame_json, get_interpreted_scenes_json
from app.models.log import Log
from app.tenancy import ensure_default_project


TRUE_VALUES = {"1", "true", "yes", "on"}
RUN_RUNTIME_E2E = os.environ.get("FRAMEOS_E2E_RUNTIME", "").lower() in TRUE_VALUES

pytestmark = pytest.mark.skipif(
    not RUN_RUNTIME_E2E,
    reason="set FRAMEOS_E2E_RUNTIME=1 to run the real FrameOS runtime integration test",
)


def _say(message: str) -> None:
    print(f"[runtime-e2e] {message}", flush=True)


@contextlib.contextmanager
def _phase(name: str) -> Iterator[None]:
    start = time.monotonic()
    _say(f"START {name}")
    try:
        yield
    except BaseException:
        _say(f"FAIL {name} after {time.monotonic() - start:.1f}s")
        raise
    else:
        _say(f"DONE {name} in {time.monotonic() - start:.1f}s")


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@contextlib.contextmanager
def _uvicorn_server(port: int) -> Iterator[str]:
    config = uvicorn.Config(
        app,
        host="127.0.0.1",
        port=port,
        log_level="warning",
        lifespan="on",
        loop="asyncio",
    )
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if server.started:
                break
            time.sleep(0.05)
        if not server.started:
            raise TimeoutError("uvicorn did not start")
        yield f"127.0.0.1:{port}"
    finally:
        server.should_exit = True
        thread.join(timeout=10)


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[4]


def _runtime_binary() -> Path:
    configured = os.environ.get("FRAMEOS_RUNTIME_BIN")
    candidates = [
        Path(configured) if configured else None,
        _repo_root() / "frameos" / "build" / "frameos",
        _repo_root() / "frameos" / "frameos",
    ]
    for candidate in candidates:
        if candidate and candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate
    raise FileNotFoundError(
        "FrameOS runtime binary not found. Run `cd frameos && nimble build` or set FRAMEOS_RUNTIME_BIN."
    )


def _render_scene() -> dict:
    return {
        "id": "runtime-e2e-render",
        "name": "Runtime E2E Render",
        "nodes": [
            {
                "id": "runtime-e2e-event",
                "type": "event",
                "position": {"x": 0, "y": 0},
                "data": {"keyword": "render"},
            }
        ],
        "edges": [],
        "fields": [],
        "settings": {"execution": "interpreted", "refreshInterval": 300},
    }


def _frame(db, *, server_port: int, frame_port: int) -> Frame:
    project = ensure_default_project(db)
    frame = Frame(
        project_id=project.id,
        name="RuntimeE2E",
        mode="rpios",
        frame_host="127.0.0.1",
        frame_port=frame_port,
        frame_access_key="frame-access-key",
        frame_access="private",
        frame_admin_auth={"enabled": False, "user": "", "pass": ""},
        https_proxy={"enable": False, "port": 8443, "certs": {}},
        ssh_user="pi",
        ssh_pass="",
        ssh_port=22,
        ssh_keys=[],
        server_host="127.0.0.1",
        server_port=server_port,
        server_api_key="runtime-e2e-server-key",
        server_send_logs=True,
        status="uninitialized",
        width=320,
        height=240,
        device="web_only",
        interval=300,
        metrics_interval=60,
        scenes=[_render_scene()],
        apps=[],
        scaling_mode="contain",
        rotate=0,
        assets_path=str(_repo_root() / "frameos" / "assets"),
        save_assets=True,
        upload_fonts="none",
        reboot={"enabled": "false"},
        control_code={"enabled": "false", "position": "top-right"},
        schedule={"events": []},
        gpio_buttons=[],
        network={"networkCheck": False, "wifiHotspot": "disabled"},
        agent={"agentEnabled": False, "agentRunCommands": False, "agentSharedSecret": "unused"},
        rpios={"crossCompilation": "never"},
        log_to_file="",
    )
    db.add(frame)
    db.commit()
    db.refresh(frame)
    return frame


def _write_runtime_inputs(db, frame: Frame, tmp_path: Path) -> tuple[Path, Path]:
    config_path = tmp_path / "frame.json"
    scenes_path = tmp_path / "scenes.json"
    config_path.write_text(json.dumps(get_frame_json(db, frame), indent=2) + "\n", encoding="utf-8")
    scenes_path.write_text(
        json.dumps(get_interpreted_scenes_json(frame), indent=2) + "\n",
        encoding="utf-8",
    )
    return config_path, scenes_path


def _start_runtime(binary: Path, config_path: Path, scenes_path: Path, tmp_path: Path) -> tuple[subprocess.Popen[str], list[str]]:
    env = os.environ.copy()
    env.update(
        {
            "FRAMEOS_CONFIG": str(config_path),
            "FRAMEOS_SCENES_JSON": str(scenes_path),
            "HOME": str(tmp_path / "home"),
        }
    )
    (tmp_path / "home").mkdir()
    output: list[str] = []
    process = subprocess.Popen(
        [str(binary), "--debug"],
        cwd=str(tmp_path),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    def _reader() -> None:
        assert process.stdout is not None
        for line in process.stdout:
            output.append(line.rstrip())
            print(f"[runtime-e2e][frameos] {line}", end="", flush=True)

    threading.Thread(target=_reader, daemon=True).start()
    return process, output


def _terminate(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=10)


def _runtime_logs(db, frame: Frame) -> list[str]:
    return [
        log.line
        for log in db.query(Log)
        .filter(Log.project_id == frame.project_id, Log.frame_id == frame.id)
        .all()
    ]


def test_real_frameos_runtime_posts_render_done_to_backend(db, tmp_path: Path) -> None:
    if not shutil.which("redis-server") and os.environ.get("REDIS_URL", "").startswith("redis://localhost"):
        pytest.skip("redis-server is required for the runtime HTTP backend test")

    server_port = _free_port()
    frame_port = _free_port()
    frame = _frame(db, server_port=server_port, frame_port=frame_port)
    binary = _runtime_binary()
    _say(f"using FrameOS runtime binary {binary}")

    with _phase("write runtime config from backend frame model"):
        config_path, scenes_path = _write_runtime_inputs(db, frame, tmp_path)

    with _phase("start real backend HTTP server"):
        with _uvicorn_server(server_port) as server:
            _say(f"backend log endpoint listening at http://{server}/api/log")
            with _phase("start real FrameOS runtime binary"):
                process, output = _start_runtime(binary, config_path, scenes_path, tmp_path)
            try:
                deadline = time.monotonic() + float(os.environ.get("FRAMEOS_E2E_RUNTIME_TIMEOUT", "60"))
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        raise AssertionError(
                            "FrameOS runtime exited before render:done\n"
                            + "\n".join(output[-80:])
                        )
                    db.expire_all()
                    lines = _runtime_logs(db, frame)
                    if any('"event": "render:done"' in line or '"event":"render:done"' in line for line in lines):
                        break
                    time.sleep(0.25)
                else:
                    raise AssertionError(
                        "Timed out waiting for render:done in backend logs\n"
                        + "\n".join(output[-120:])
                    )
            finally:
                _terminate(process)

    db.expire_all()
    frame = db.get(Frame, frame.id)
    assert frame is not None
    assert frame.status == "ready"
    all_logs = "\n".join(_runtime_logs(db, frame))
    assert "bootup" in all_logs
    assert "render:done" in all_logs
    _say("real FrameOS runtime produced backend render:done logs")
