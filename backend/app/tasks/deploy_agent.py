from __future__ import annotations

from datetime import datetime
import json
import os
import random
import shutil
import string
import tempfile
from typing import Any, Optional, List

import asyncssh
from arq import ArqRedis as Redis
from sqlalchemy.orm import Session

from app.models.log import new_log as log
from app.models.frame import Frame, get_frame_json
from app.utils.ssh_utils import (
    get_ssh_connection,
    exec_command,
    remove_ssh_connection,
)
from app.utils.local_exec import exec_local_command
from .utils import find_nim_v2, find_nimbase_file


async def deploy_agent(id: int, redis: Redis) -> None:  # noqa: N802
    await redis.enqueue_job("deploy_agent", id=id)


async def deploy_agent_task(ctx: dict[str, Any], id: int):  # noqa: N802
    db: Session = ctx["db"]
    redis: Redis = ctx["redis"]

    frame: Optional[Frame] = db.get(Frame, id)
    if frame is None:  # keep the early-exit guard
        raise Exception("Frame not found")

    deployer = AgentDeployer(db, redis, frame)
    await deployer.run()


class AgentDeployer:
    def __init__(self, db: Session, redis: Redis, frame: Frame):
        self.db = db
        self.redis = redis
        self.frame = frame

        # Attributes initialised later inside ``run()``
        self.nim_path: str = ""
        self.temp_dir: str = ""
        self.ssh: Optional[asyncssh.SSHClientConnection] = None

        # Build identifier (12-random-letters)
        self.build_id = "".join(random.choices(string.ascii_lowercase, k=12))

    async def run(self) -> None:
        """Main orchestration coroutine (used by global ``deploy_agent_task``)."""
        try:
            self.nim_path = find_nim_v2()
            self.ssh = await get_ssh_connection(self.db, self.redis, self.frame)

            with tempfile.TemporaryDirectory() as temp_dir:
                self.temp_dir = temp_dir

                await self.log(
                    "stdout",
                    f"Deploying agent {self.frame.name} with build id {self.build_id}",
                )

                # 1. Detect CPU architecture on target
                cpu = await self._detect_remote_cpu()

                # 2. Build & deploy the agent (if needed)
                if self._can_deploy_agent():
                    await self.log("stdout", "- Deploying agent")
                    await self._deploy_agent(cpu)
                    await self._setup_agent_service()

                    # 3. Upload *frame.json* for this release
                    await self._upload_frame_json()

                    # 4. Atomically switch *current* → new release + housekeeping
                    await self.exec_command(
                        "rm -rf /srv/frameos/agent/current && "
                        f"ln -s /srv/frameos/agent/releases/release_{self.build_id} "
                        "/srv/frameos/agent/current"
                    )

                    # Enable + start service
                    await self.exec_command("sudo systemctl enable frameos_agent.service")
                    await self.exec_command("sudo systemctl restart frameos_agent.service")
                    await self.exec_command("sudo systemctl status frameos_agent.service")
                else:
                    await self.log(
                        "stdout",
                        f"- Skipping agent deployment for {self.frame.name} (no agent connection configured)"
                    )
                    # If the frame has no agent connection configured, disable service
                    await self.exec_command(
                        "sudo systemctl disable frameos_agent.service", raise_on_error=False
                    )
                    await self.exec_command(
                        "sudo systemctl stop frameos_agent.service", raise_on_error=False
                    )

                await self._cleanup_old_builds()
                await self.log(
                    "stdout",
                    f"Agent deployment completed for {self.frame.name} (build id: {self.build_id})",
                )

        except Exception as exc:  # keep logging parity with legacy code
            await self.log("stderr", str(exc))
            raise
        finally:
            if self.ssh is not None:
                await remove_ssh_connection(self.db, self.redis, self.ssh, self.frame)

    async def exec_command(
        self,
        command: str,
        output: Optional[List[str]] = None,
        *,
        log_output: bool = True,
        raise_on_error: bool = True,
    ) -> int:
        if self.ssh is None:
            raise Exception("SSH connection is not established")
        return await exec_command(
            self.db,
            self.redis,
            self.frame,
            self.ssh,
            command,
            output=output,
            log_output=log_output,
            raise_on_error=raise_on_error,
        )

    async def log(
        self,
        type: str,  # noqa: A002 (match original signature)
        line: str,
        timestamp: Optional[datetime] = None,
    ) -> None:
        await log(self.db, self.redis, int(self.frame.id), type=type, line=line, timestamp=timestamp)

    def _can_deploy_agent(self) -> bool:
        """Whether ``frame.network`` declares an agent link + shared secret."""
        agent = self.frame.agent or {}
        return bool(agent.get("agentEnabled") and len(str(agent.get("agentSharedSecret", ""))) > 0)

    async def _detect_remote_cpu(self) -> str:
        """SSH into the device and map `uname -m` to Nim's `--cpu:` flag."""
        uname_out: List[str] = []
        await self.exec_command("uname -m", uname_out)
        arch = "".join(uname_out).strip()

        if arch in {"aarch64", "arm64"}:
            return "arm64"
        if arch in {"armv6l", "armv7l"}:
            return "arm"
        if arch == "i386":
            return "i386"
        return "amd64"

    # --------------- BUILD ─────────────────────────────────────────---- #

    def _create_agent_build_folders(self) -> tuple[str, str]:
        """
        Return `(build_dir, source_dir)`.

        * ``build_dir`` holds the Nim intermediate artefacts.
        * ``source_dir`` is a fresh copy of `../agent`.
        """
        build_dir = os.path.join(self.temp_dir, f"agent_{self.build_id}")
        source_dir = os.path.join(self.temp_dir, "agent")

        os.makedirs(source_dir, exist_ok=True)
        shutil.copytree("../agent", source_dir, dirs_exist_ok=True)  # idempotent copy
        os.makedirs(build_dir, exist_ok=True)

        return build_dir, source_dir

    async def _create_local_build_archive(
        self,
        build_dir: str,
        source_dir: str,
        cpu: str,
    ) -> str:
        """Compile locally (generate C + scripts), tarball the build directory, return archive path."""
        debug_opts = "--lineTrace:on" if self.frame.debug else ""
        cmd = (
            f"cd {source_dir} && nimble setup && "
            f"{self.nim_path} compile --os:linux --cpu:{cpu} "
            f"--compileOnly --genScript --nimcache:{build_dir} -d:ssl "
            f"{debug_opts} src/frameos_agent.nim 2>&1"
        )

        status, *_ = await exec_local_command(self.db, self.redis, self.frame, cmd)
        if status != 0:
            raise Exception("Failed to generate agent sources")

        # Copy nimbase.h because the generated C depends on it
        nimbase_path = find_nimbase_file(self.nim_path)
        if not nimbase_path:
            raise Exception("nimbase.h not found")
        shutil.copy(nimbase_path, os.path.join(build_dir, "nimbase.h"))

        archive_path = os.path.join(self.temp_dir, f"agent_{self.build_id}.tar.gz")
        shutil.make_archive(
            base_name=os.path.join(self.temp_dir, f"agent_{self.build_id}"),
            format="gztar",
            root_dir=self.temp_dir,
            base_dir=f"agent_{self.build_id}",
        )
        return archive_path

    # --------------- DEPLOY ─────────────────────────────────────────--- #

    async def _deploy_agent(self, cpu: str) -> None:
        """
        Build the agent locally, upload the tarball to the device,
        compile natively, and stage the binary in the new release folder.
        """
        build_dir, source_dir = self._create_agent_build_folders()
        archive_path = await self._create_local_build_archive(build_dir, source_dir, cpu)

        # Ensure directory structure exists
        await self.exec_command(
            "mkdir -p /srv/frameos/agent/build/ /srv/frameos/agent/logs/ /srv/frameos/agent/releases/"
        )

        # Upload archive
        await asyncssh.scp(
            archive_path,
            (self.ssh, f"/srv/frameos/agent/build/agent_{self.build_id}.tar.gz"),
            recurse=False,
        )

        # Unpack & compile _on the device_
        await self.exec_command(
            f"cd /srv/frameos/agent/build && tar -xzf agent_{self.build_id}.tar.gz && "
            f"rm agent_{self.build_id}.tar.gz"
        )
        await self.exec_command(
            f"cd /srv/frameos/agent/build/agent_{self.build_id} && sh compile_frameos_agent.sh"
        )

        # Stage binary into new release dir
        await self.exec_command(
            f"mkdir -p /srv/frameos/agent/releases/release_{self.build_id}"
        )
        await self.exec_command(
            f"cp /srv/frameos/agent/build/agent_{self.build_id}/frameos_agent "
            f"/srv/frameos/agent/releases/release_{self.build_id}/frameos_agent"
        )

    # --------------- SYSTEMD SERVICE ----------------------------------- #

    async def _setup_agent_service(self) -> None:
        """Upload and install the systemd service file for the new release."""
        with open("../agent/frameos_agent.service", "r", encoding="utf-8") as fh:
            service_contents = fh.read().replace("%I", self.frame.ssh_user)

        # Local temp copy
        with tempfile.NamedTemporaryFile("w+b", suffix=".service", delete=False) as tmp:
            tmp_path = tmp.name
            tmp.write(service_contents.encode())

        # Ship service file with the release
        await asyncssh.scp(
            tmp_path,
            (self.ssh, f"/srv/frameos/agent/releases/release_{self.build_id}/frameos_agent.service"),
            recurse=False,
        )
        os.remove(tmp_path)

        # Activate system-wide
        await self.exec_command(
            f"sudo cp /srv/frameos/agent/releases/release_{self.build_id}/frameos_agent.service "
            "/etc/systemd/system/frameos_agent.service"
        )
        await self.exec_command("sudo chown root:root /etc/systemd/system/frameos_agent.service")
        await self.exec_command("sudo chmod 644 /etc/systemd/system/frameos_agent.service")

    # --------------- MISC ------------------------------------------------ #

    async def _upload_frame_json(self) -> None:
        """Upload the release-specific `frame.json`."""
        json_data = json.dumps(get_frame_json(self.db, self.frame), indent=4).encode() + b"\n"

        with tempfile.NamedTemporaryFile("wb", suffix=".json", delete=False) as tmp:
            tmp_path = tmp.name
            tmp.write(json_data)

        await asyncssh.scp(
            tmp_path,
            (self.ssh, f"/srv/frameos/agent/releases/release_{self.build_id}/frame.json"),
            recurse=False,
        )
        os.remove(tmp_path)
        await self.log(
            "stdout",
            f"> add /srv/frameos/agent/releases/release_{self.build_id}/frame.json",
        )

    async def _cleanup_old_builds(self) -> None:
        """Keep only the 10 most-recent builds + releases on the device."""
        # Prune `/build`
        await self.exec_command(
            "cd /srv/frameos/agent/build && ls -dt1 agent_* | tail -n +11 | xargs rm -rf"
        )
        # Prune `/releases` except for the one currently linked
        await self.exec_command(
            "cd /srv/frameos/agent/releases && "
            'ls -dt1 release_* | grep -v "$(basename $(readlink ../current))" | '
            "tail -n +11 | xargs rm -rf"
        )
