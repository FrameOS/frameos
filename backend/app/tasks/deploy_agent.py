from __future__ import annotations

import os
import shlex
import shutil
import tempfile
from typing import Any, Optional

import asyncssh
from arq import ArqRedis as Redis
from sqlalchemy.orm import Session

from app.models.frame import Frame
from app.utils.ssh_utils import (
    get_ssh_connection,
    remove_ssh_connection,
)
from app.utils.local_exec import exec_local_command
from app.tasks._frame_deployer import FrameDeployer
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


class AgentDeployer(FrameDeployer):
    ssh: Optional[asyncssh.SSHClientConnection] = None

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
                arch = await self.get_cpu_architecture()

                # 2. Build & deploy the agent (if needed)
                if self._can_deploy_agent():
                    await self.log("stdout", "- Deploying agent")

                    distro_out: list[str] = []
                    await self.exec_command(
                        "bash -c '"
                        "if [ -e /etc/nixos/version ]; then echo nixos ; "
                        "elif [ -f /etc/rpi-issue ] || grep -q \"^ID=raspbian\" /etc/os-release ; then echo raspios ; "
                        "else . /etc/os-release ; echo ${ID:-unknown} ; "
                        "fi'",
                        distro_out
                    )
                    distro = distro_out[0].strip().lower()

                    if distro == "nixos":
                        await self.log("stderr", "NixOS is not supported for agent deployment")
                    else:
                        await self._deploy_agent(arch)
                        await self._setup_agent_service()

                        # 3. Upload *frame.json* for this release
                        await self._upload_frame_json(f"/srv/frameos/agent/releases/release_{self.build_id}/frame.json")

                        # 4. Atomically switch *current* → new release + housekeeping
                        await self.exec_command(
                            "rm -rf /srv/frameos/agent/current && "
                            f"ln -s /srv/frameos/agent/releases/release_{self.build_id} "
                            "/srv/frameos/agent/current"
                        )

                        # Enable + start service
                        await self.restart_service("frameos_agent")

                        await self._cleanup_old_builds()
                        await self.log(
                            "stdout",
                            f"Agent deployment completed for {self.frame.name} (build id: {self.build_id})",
                        )
                else:
                    await self.log(
                        "stdout",
                        f"- Skipping agent deployment for {self.frame.name} (no agent connection configured)"
                    )
                    # If the frame has no agent connection configured, disable service
                    await self.disable_service("frameos_agent")
                    await self.stop_service("frameos_agent")


        except Exception as exc:  # keep logging parity with legacy code
            await self.log("stderr", str(exc))
            raise
        finally:
            if self.ssh is not None:
                await remove_ssh_connection(self.db, self.redis, self.ssh, self.frame)

    def _can_deploy_agent(self) -> bool:
        """Whether ``frame.network`` declares an agent link + shared secret."""
        agent = self.frame.agent or {}
        return bool(agent.get("agentEnabled") and len(str(agent.get("agentSharedSecret", ""))) > 0)

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
        shutil.copytree("./agent", source_dir, dirs_exist_ok=True)  # idempotent copy
        os.makedirs(build_dir, exist_ok=True)

        return build_dir, source_dir

    async def _create_local_build_archive(
        self,
        build_dir: str,
        source_dir: str,
        arch: str,
    ) -> str:
        """Compile locally (generate C + scripts), tarball the build directory, return archive path."""
        debug_opts = "--lineTrace:on" if self.frame.debug else ""
        cpu = await self.arch_to_nim_cpu(arch)
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

    async def _deploy_agent(self, arch: str) -> None:
        """
        Build the agent locally, upload the tarball to the device,
        compile natively, and stage the binary in the new release folder.
        """
        build_dir, source_dir = self._create_agent_build_folders()
        archive_path = await self._create_local_build_archive(build_dir, source_dir, arch)

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
        with open("./agent/frameos_agent.service", "r", encoding="utf-8") as fh:
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
    # TODO: deduplicate with deploy_frame

    async def _store_paths_missing(self, paths: list[str]) -> list[str]:
        """
        Return *only* those paths that are **missing** from /nix/store on the
        frame.  All paths are checked in a single SSH exec.
        """
        if not paths:
            return []

        # Quote every path once; the remote loop echoes the missing ones.
        joined = " ".join(shlex.quote(p) for p in paths)
        script = "for p; do [ -e \"$p\" ] || echo \"$p\"; done"
        out: list[str] = []
        await self.exec_command(
            f"bash -s -- {joined} <<'EOF'\n{script}\nEOF",
            output=out,
            raise_on_error=False,
            log_output=False,
        )
        # Every line produced by the loop is a missing store path.
        return [p.strip() for p in out if p.strip()]

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
