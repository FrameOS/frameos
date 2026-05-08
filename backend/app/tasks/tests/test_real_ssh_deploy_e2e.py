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
from dataclasses import dataclass
from functools import partial
from pathlib import Path
from typing import Any, Iterator

import asyncssh
import pytest

from app.models.frame import Frame
from app.models.log import Log
from app.tasks._frame_deployer import FrameDeployer
from app.tasks import precompiled_frameos
from app.tasks.frame_deploy_workflow import FrameDeployPlan, FrameDeployWorkflow
from app.tasks.precompiled_frameos import release_version
from app.tasks.utils import find_nim_v2


TRUE_VALUES = {"1", "true", "yes", "on"}
RUN_DEPLOY_E2E = os.environ.get("FRAMEOS_E2E_DEPLOY", "").lower() in TRUE_VALUES
PRECOMPILED_TARGET = "debian-bookworm-amd64"

pytestmark = pytest.mark.skipif(
    not RUN_DEPLOY_E2E,
    reason="set FRAMEOS_E2E_DEPLOY=1 to run the real SSH deploy integration test",
)


class NullRedis:
    async def publish(self, *_args: Any, **_kwargs: Any) -> None:
        return None


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
        _wait_for_ssh(external_target)
        yield external_target
        return

    if not shutil.which("docker"):
        pytest.skip("docker is required for FRAMEOS_E2E_DEPLOY without FRAMEOS_E2E_DEPLOY_HOST")

    dockerfile = Path(__file__).with_name("deploy_ssh_target") / "Dockerfile"
    tag = "frameos-deploy-e2e-ssh-target:latest"
    container_id = ""
    try:
        _run_docker(["build", "-q", "-t", tag, str(dockerfile.parent)])
        container_id = _run_docker(["run", "-d", "-p", "127.0.0.1::22", tag])
        port = int(_run_docker(["port", container_id, "22/tcp"]).rsplit(":", 1)[1])
        target = SshTarget(
            host="127.0.0.1",
            port=port,
            user="frame",
            password="framepass",
            container_id=container_id,
        )
        _wait_for_ssh(target)
        yield target
    finally:
        if container_id:
            subprocess.run(
                ["docker", "rm", "-f", container_id],
                check=False,
                stdout=subprocess.DEVNULL,
            )


def _wait_for_ssh(target: SshTarget) -> None:
    async def _probe() -> None:
        for _ in range(90):
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
                        return
            except (OSError, asyncssh.Error):
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
    frame = Frame(
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
    await workflow.execute(plan)
    return plan


async def _run_fast_deploy(db, redis: NullRedis, frame: Frame) -> FrameDeployPlan:
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
    artifact_root = release_root / "payload" / "prebuilt-cross" / PRECOMPILED_TARGET
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
        archive.add(release_root / "payload" / "prebuilt-cross", arcname="prebuilt-cross")
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
        yield f"http://127.0.0.1:{server.server_port}/"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def _log_lines(db, frame: Frame) -> list[str]:
    return [log.line for log in db.query(Log).filter(Log.frame_id == frame.id).all()]


@pytest.mark.asyncio
async def test_real_ssh_full_fast_cross_and_precompiled_deploy(
    db,
    ssh_target: SshTarget,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    redis = NullRedis()
    nim_path = find_nim_v2()
    monkeypatch.setenv("FRAMEOS_CROSS_CACHE", str(tmp_path / "cross-cache"))
    monkeypatch.setenv("FRAMEOS_CROSS_MAKE_JOBS", os.environ.get("FRAMEOS_CROSS_MAKE_JOBS", "2"))
    monkeypatch.setenv("FRAMEOS_PRECOMPILED_CACHE_DIR", str(tmp_path / "precompiled-cache"))

    remote_frame = _frame(
        db,
        ssh_target,
        name="DeployE2ERemote",
        rpios={"crossCompilation": "never"},
    )
    remote_plan = await _run_full_deploy(
        db,
        redis,
        remote_frame,
        temp_dir=tmp_path / "remote-build",
        nim_path=nim_path,
    )
    assert remote_plan.full_deploy is not None
    assert remote_plan.full_deploy.binary_plan.will_attempt_cross_compile is False
    assert remote_frame.status == "starting"
    await _assert_current_binary_runs(db, redis, remote_frame)

    remote_frame.https_proxy = {"enable": True, "port": 9443, "certs": {}}
    db.add(remote_frame)
    db.commit()
    fast_plan = await _run_fast_deploy(db, redis, remote_frame)
    assert fast_plan.fast_deploy is not None
    assert fast_plan.fast_deploy.action == "restart_service"
    assert remote_frame.last_successful_deploy["https_proxy"]["port"] == 9443

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
    await _assert_current_binary_runs(db, redis, cross_frame)

    compiled_binary = tmp_path / "compiled-frameos"
    await _download_remote_file(ssh_target, "/srv/frameos/current/frameos", compiled_binary)
    assert compiled_binary.stat().st_size > 1024 * 1024

    release_root = tmp_path / "precompiled-release"
    _build_precompiled_release_archive(compiled_binary, release_root)
    monkeypatch.setattr(precompiled_frameos, "RELEASE_BASE_URL", "")

    with _serve_directory(release_root) as base_url:
        monkeypatch.setattr(precompiled_frameos, "RELEASE_BASE_URL", base_url)
        precompiled_frame = _frame(
            db,
            ssh_target,
            name="DeployE2EPrecompiled",
            rpios={"crossCompilation": "auto", "driverBuildMode": "precompiled"},
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
    await _assert_current_binary_runs(db, redis, precompiled_frame)

    current_frame_json = await _remote_read(db, redis, precompiled_frame, "/srv/frameos/current/frame.json")
    assert '"name": "DeployE2EPrecompiled"' in current_frame_json

    all_logs = "\n".join(
        _log_lines(db, remote_frame)
        + _log_lines(db, cross_frame)
        + _log_lines(db, precompiled_frame)
    )
    assert "Generating C sources from Nim sources" in all_logs
    assert "Building FrameOS on remote, no cross-compilation" in all_logs
    assert "Cross compilation succeeded; skipping remote build" in all_logs
    assert "Using precompiled FrameOS binary" in all_logs
