from __future__ import annotations

import asyncio
import contextlib
import http.server
import json
import os
import shutil
import subprocess
import tarfile
import threading
import time
from dataclasses import dataclass
from functools import partial
from pathlib import Path
from typing import Any, Iterator

import asyncssh
import pytest

from app.codegen.drivers_nim import COMPILATION_MODE_STATIC
from app.models.frame import Frame
from app.models.log import Log
from app.tasks._frame_deployer import FrameDeployer
from app.tasks import precompiled_frameos
from app.tasks.frame_deploy_workflow import FrameDeployPlan, FrameDeployWorkflow
from app.tasks.precompiled_frameos import release_version
from app.tasks.utils import find_nim_v2
from app.tenancy import ensure_default_project


TRUE_VALUES = {"1", "true", "yes", "on"}
RUN_DEPLOY_E2E = os.environ.get("FRAMEOS_E2E_DEPLOY", "").lower() in TRUE_VALUES
PRECOMPILED_TARGET = "debian-bookworm-amd64"

pytestmark = pytest.mark.skipif(
    not RUN_DEPLOY_E2E,
    reason="set FRAMEOS_E2E_DEPLOY=1 to run the real SSH deploy integration test",
)


def _say(message: str) -> None:
    print(f"[deploy-e2e] {message}", flush=True)


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


class NullRedis:
    async def publish(self, channel: str, payload: Any, *_args: Any, **_kwargs: Any) -> None:
        if channel != "broadcast_channel":
            return
        if isinstance(payload, bytes):
            payload = payload.decode("utf-8", errors="replace")
        try:
            message = json.loads(payload)
        except (TypeError, json.JSONDecodeError):
            _say(f"redis publish {channel}: {payload}")
            return

        if message.get("event") != "new_log":
            return
        data = message.get("data") or {}
        log_type = data.get("type", "log")
        frame_id = data.get("frame_id", "?")
        line = str(data.get("line", "")).rstrip()
        if line:
            print(f"[deploy-e2e][frame:{frame_id}][{log_type}] {line}", flush=True)


@dataclass(frozen=True)
class SshTarget:
    host: str
    port: int
    user: str
    password: str | None
    container_id: str | None = None


def _external_target_from_env() -> SshTarget | None:
    host = os.environ.get("FRAMEOS_E2E_DEPLOY_HOST")
    if not host:
        return None
    return SshTarget(
        host=host,
        port=int(os.environ.get("FRAMEOS_E2E_DEPLOY_PORT", "22")),
        user=os.environ.get("FRAMEOS_E2E_DEPLOY_USER", "frame"),
        password=os.environ.get("FRAMEOS_E2E_DEPLOY_PASSWORD") or None,
    )


def _run_docker(args: list[str]) -> str:
    _say("docker " + " ".join(args))
    result = subprocess.run(
        ["docker", *args],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    return result.stdout.strip()


@pytest.fixture(scope="module")
def ssh_target() -> Iterator[SshTarget]:
    external_target = _external_target_from_env()
    if external_target:
        _say(
            f"using external SSH target {external_target.user}@"
            f"{external_target.host}:{external_target.port}"
        )
        with _phase("wait for external SSH target"):
            _wait_for_ssh(external_target)
        yield external_target
        return

    if not shutil.which("docker"):
        pytest.skip("docker is required for FRAMEOS_E2E_DEPLOY without FRAMEOS_E2E_DEPLOY_HOST")

    dockerfile = Path(__file__).with_name("deploy_ssh_target") / "Dockerfile"
    tag = "frameos-deploy-e2e-ssh-target:latest"
    container_id = ""
    try:
        with _phase("build disposable SSH target image"):
            _run_docker(["build", "-q", "-t", tag, str(dockerfile.parent)])
        with _phase("start disposable SSH target container"):
            container_id = _run_docker(["run", "-d", "-p", "127.0.0.1::22", tag])
        port = int(_run_docker(["port", container_id, "22/tcp"]).rsplit(":", 1)[1])
        target = SshTarget(
            host="127.0.0.1",
            port=port,
            user="frame",
            password="framepass",
            container_id=container_id,
        )
        _say(f"disposable SSH target listening on {target.host}:{target.port}")
        with _phase("wait for disposable SSH target"):
            _wait_for_ssh(target)
        yield target
    finally:
        if container_id:
            _say(f"removing disposable SSH target container {container_id[:12]}")
            subprocess.run(
                ["docker", "rm", "-f", container_id],
                check=False,
                stdout=subprocess.DEVNULL,
            )


def _wait_for_ssh(target: SshTarget) -> None:
    async def _probe() -> None:
        for attempt in range(90):
            try:
                async with asyncssh.connect(
                    target.host,
                    port=target.port,
                    username=target.user,
                    password=target.password,
                    known_hosts=None,
                ) as ssh:
                    result = await ssh.run("echo ready", check=True)
                    if result.stdout.strip() == "ready":
                        _say(f"SSH target ready after {attempt + 1} probe(s)")
                        return
            except (OSError, asyncssh.Error):
                if attempt == 0 or (attempt + 1) % 10 == 0:
                    _say(f"waiting for SSH target, probe {attempt + 1}/90")
                await asyncio.sleep(0.5)
        raise TimeoutError("SSH target did not become ready")

    asyncio.run(_probe())


def _frame(
    db,
    target: SshTarget,
    *,
    name: str,
    rpios: dict[str, Any],
) -> Frame:
    project = ensure_default_project(db)
    frame = Frame(
        project_id=project.id,
        name=name,
        mode="rpios",
        frame_host=target.host,
        frame_port=8787,
        frame_access_key="frame-access-key",
        frame_access="private",
        frame_admin_auth={"enabled": False, "user": "", "pass": ""},
        https_proxy={"enable": False, "port": 8443, "certs": {}},
        ssh_user=target.user,
        ssh_pass=target.password,
        ssh_port=target.port,
        ssh_keys=[],
        server_host="localhost",
        server_port=8989,
        server_api_key="server-key",
        server_send_logs=True,
        status="uninitialized",
        width=800,
        height=480,
        device="web_only",
        interval=300,
        metrics_interval=60,
        scenes=[
            {
                "id": "interpreted-scene",
                "name": "Interpreted",
                "settings": {"execution": "interpreted"},
                "nodes": [],
            }
        ],
        apps=[],
        scaling_mode="contain",
        rotate=0,
        assets_path="/srv/assets",
        save_assets=True,
        upload_fonts="none",
        reboot={"enabled": "false"},
        control_code={"enabled": "false", "position": "top-right"},
        schedule={"events": []},
        gpio_buttons=[],
        network={
            "networkCheck": False,
            "wifiHotspot": "disabled",
        },
        agent={
            "agentEnabled": False,
            "agentRunCommands": False,
            "agentSharedSecret": "unused",
        },
        rpios=rpios,
    )
    db.add(frame)
    db.commit()
    db.refresh(frame)
    return frame


async def _run_full_deploy(
    db,
    redis: NullRedis,
    frame: Frame,
    *,
    temp_dir: Path,
    nim_path: str,
) -> FrameDeployPlan:
    _say(f"planning full deploy for frame {frame.id} ({frame.name})")
    temp_dir.mkdir(parents=True, exist_ok=True)
    deployer = FrameDeployer(db=db, redis=redis, frame=frame, nim_path=nim_path, temp_dir=str(temp_dir))
    workflow = FrameDeployWorkflow(
        db=db,
        redis=redis,
        frame=frame,
        deployer=deployer,
        temp_dir=str(temp_dir),
    )
    plan = await workflow.plan("full")
    assert plan.full_deploy is not None
    binary_plan = plan.full_deploy.binary_plan
    _say(
        "full deploy plan: "
        f"precompiled={binary_plan.will_attempt_precompiled}, "
        f"cross_compile={binary_plan.will_attempt_cross_compile}, "
        f"remote_build={not binary_plan.will_attempt_precompiled and not binary_plan.will_attempt_cross_compile}"
    )
    await workflow.execute(plan)
    return plan


async def _run_fast_deploy(db, redis: NullRedis, frame: Frame) -> FrameDeployPlan:
    _say(f"planning fast deploy for frame {frame.id} ({frame.name})")
    deployer = FrameDeployer(db=db, redis=redis, frame=frame, nim_path="", temp_dir="")
    workflow = FrameDeployWorkflow(
        db=db,
        redis=redis,
        frame=frame,
        deployer=deployer,
        temp_dir="",
    )
    plan = await workflow.plan("fast")
    assert plan.fast_deploy is not None
    _say(
        "fast deploy plan: "
        f"action={plan.fast_deploy.action}, "
        f"tls_changed={plan.fast_deploy.tls_settings_changed}"
    )
    assert plan.fast_deploy.tls_settings_changed is True
    await workflow.execute(plan)
    return plan


async def _remote_read(db, redis: NullRedis, frame: Frame, path: str) -> str:
    deployer = FrameDeployer(db=db, redis=redis, frame=frame, nim_path="", temp_dir="")
    output: list[str] = []
    await deployer.exec_command(f"cat {path}", output=output, log_output=False, log_command=False)
    return "\n".join(output)


async def _assert_current_binary_runs(db, redis: NullRedis, frame: Frame) -> None:
    deployer = FrameDeployer(db=db, redis=redis, frame=frame, nim_path="", temp_dir="")
    output: list[str] = []
    await deployer.exec_command(
        "/srv/frameos/current/frameos help",
        output=output,
        log_output=False,
        log_command=False,
    )
    assert "setup" in "\n".join(output)


async def _download_remote_file(target: SshTarget, remote_path: str, local_path: Path) -> None:
    _say(f"downloading {remote_path} from SSH target to {local_path}")
    async with asyncssh.connect(
        target.host,
        port=target.port,
        username=target.user,
        password=target.password,
        known_hosts=None,
    ) as ssh:
        await asyncssh.scp((ssh, remote_path), str(local_path))


def _build_precompiled_release_archive(binary_path: Path, release_root: Path) -> Path:
    version = release_version()
    assert version
    release_dir = release_root / f"v{version}"
    archive_root_name = f"frameos-{version}-{PRECOMPILED_TARGET}"
    artifact_root = release_root / "payload" / archive_root_name
    release_dir.mkdir(parents=True, exist_ok=True)
    artifact_root.mkdir(parents=True, exist_ok=True)

    packaged_binary = artifact_root / "frameos"
    shutil.copy2(binary_path, packaged_binary)
    packaged_binary.chmod(0o755)
    (artifact_root / "metadata.json").write_text(
        json.dumps(
            {
                "slug": PRECOMPILED_TARGET,
                "release_artifact": True,
                "driver_libraries": [],
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )

    archive_path = release_dir / f"frameos-{version}-{PRECOMPILED_TARGET}.tar.gz"
    with tarfile.open(archive_path, "w:gz") as archive:
        archive.add(artifact_root, arcname=archive_root_name)
    _say(f"packaged local precompiled release archive {archive_path}")
    return archive_path


@contextlib.contextmanager
def _serve_directory(root: Path) -> Iterator[str]:
    class QuietHandler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, _format: str, *_args: Any) -> None:
            return None

    handler = partial(QuietHandler, directory=str(root))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        base_url = f"http://127.0.0.1:{server.server_port}/"
        _say(f"serving local precompiled release archive from {base_url}")
        yield base_url
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        _say("stopped local precompiled release server")


def _log_lines(db, frame: Frame) -> list[str]:
    return [
        log.line
        for log in db.query(Log)
        .filter(Log.project_id == frame.project_id, Log.frame_id == frame.id)
        .all()
    ]


@pytest.mark.asyncio
async def test_real_ssh_full_fast_cross_and_precompiled_deploy(
    db,
    ssh_target: SshTarget,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _say("starting real SSH deploy E2E")
    redis = NullRedis()
    nim_path = find_nim_v2()
    _say(f"using Nim compiler at {nim_path}")
    monkeypatch.setenv("FRAMEOS_CROSS_CACHE", str(tmp_path / "cross-cache"))
    monkeypatch.setenv("FRAMEOS_CROSS_MAKE_JOBS", os.environ.get("FRAMEOS_CROSS_MAKE_JOBS", "2"))
    monkeypatch.setenv("FRAMEOS_PRECOMPILED_CACHE_DIR", str(tmp_path / "precompiled-cache"))

    with _phase("full deploy with compile on device"):
        remote_frame = _frame(
            db,
            ssh_target,
            name="DeployE2ERemote",
            rpios={"crossCompilation": "never", "compilationMode": COMPILATION_MODE_STATIC},
        )
        remote_plan = await _run_full_deploy(
            db,
            redis,
            remote_frame,
            temp_dir=tmp_path / "remote-build",
            nim_path=nim_path,
        )
    assert remote_plan.full_deploy is not None
    assert remote_plan.full_deploy.binary_plan.compilation_mode == COMPILATION_MODE_STATIC
    assert remote_plan.full_deploy.binary_plan.will_attempt_precompiled is False
    assert remote_plan.full_deploy.binary_plan.will_attempt_cross_compile is False
    assert remote_frame.status == "starting"
    with _phase("verify remote-built binary runs"):
        await _assert_current_binary_runs(db, redis, remote_frame)

    remote_frame.https_proxy = {"enable": True, "port": 9443, "certs": {}}
    db.add(remote_frame)
    db.commit()
    with _phase("fast deploy restart path"):
        fast_plan = await _run_fast_deploy(db, redis, remote_frame)
    assert fast_plan.fast_deploy is not None
    assert fast_plan.fast_deploy.action == "restart_service"
    assert remote_frame.last_successful_deploy["https_proxy"]["port"] == 9443

    with _phase("full deploy with backend cross compile"):
        cross_frame = _frame(
            db,
            ssh_target,
            name="DeployE2ECross",
            rpios={"crossCompilation": "always"},
        )
        cross_plan = await _run_full_deploy(
            db,
            redis,
            cross_frame,
            temp_dir=tmp_path / "cross-build",
            nim_path=nim_path,
        )
    assert cross_plan.full_deploy is not None
    assert cross_plan.full_deploy.binary_plan.will_attempt_cross_compile is True
    assert cross_frame.status == "starting"
    with _phase("verify cross-compiled binary runs"):
        await _assert_current_binary_runs(db, redis, cross_frame)

    compiled_binary = tmp_path / "compiled-frameos"
    with _phase("download deployed binary for precompiled release fixture"):
        await _download_remote_file(ssh_target, "/srv/frameos/current/frameos", compiled_binary)
    assert compiled_binary.stat().st_size > 1024 * 1024
    _say(f"downloaded binary size: {compiled_binary.stat().st_size} bytes")

    release_root = tmp_path / "precompiled-release"
    with _phase("package local precompiled release archive"):
        _build_precompiled_release_archive(compiled_binary, release_root)
    monkeypatch.setattr(precompiled_frameos, "RELEASE_BASE_URL", "")

    with _phase("full deploy using precompiled binary"):
        with _serve_directory(release_root) as base_url:
            monkeypatch.setattr(precompiled_frameos, "RELEASE_BASE_URL", base_url)
            precompiled_frame = _frame(
                db,
                ssh_target,
                name="DeployE2EPrecompiled",
                rpios={"crossCompilation": "auto", "compilationMode": "precompiled"},
            )
            precompiled_plan = await _run_full_deploy(
                db,
                redis,
                precompiled_frame,
                temp_dir=tmp_path / "precompiled-build",
                nim_path=nim_path,
            )

    assert precompiled_plan.full_deploy is not None
    assert precompiled_plan.full_deploy.binary_plan.will_attempt_precompiled is True
    assert precompiled_frame.status == "starting"
    with _phase("verify precompiled binary runs"):
        await _assert_current_binary_runs(db, redis, precompiled_frame)

    with _phase("verify deployed frame.json"):
        current_frame_json = await _remote_read(db, redis, precompiled_frame, "/srv/frameos/current/frame.json")
    assert '"name": "DeployE2EPrecompiled"' in current_frame_json

    _say("checking deploy logs for required evidence")
    all_logs = "\n".join(
        _log_lines(db, remote_frame)
        + _log_lines(db, cross_frame)
        + _log_lines(db, precompiled_frame)
    )
    assert "Generating C sources from Nim sources" in all_logs
    assert "Building FrameOS on remote, no cross-compilation" in all_logs
    assert "Cross compilation succeeded; skipping remote build" in all_logs
    assert "Using precompiled FrameOS binary" in all_logs
    _say("real SSH deploy E2E completed successfully")
