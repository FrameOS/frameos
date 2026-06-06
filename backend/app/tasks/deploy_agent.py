from __future__ import annotations

import asyncio
import hashlib
import os
import shlex
import shutil
import tempfile
from pathlib import Path
from typing import Any, Optional

from arq import ArqRedis as Redis
from sqlalchemy.orm import Session

from app.models.frame import Frame
from app.models.log import new_log as log
from app.models.settings import get_settings_dict
from app.utils.build_environment import selected_build_environment_provider
from app.utils.local_exec import exec_local_command
from app.utils.remote_exec import RemoteTransport, upload_file
from app.tasks._frame_deployer import FrameDeployer
from app.tasks.frame_deploy_helpers import sanitize_apt_package_name
from app.tasks.prebuilt_deps import resolve_prebuilt_target
from app.tasks.precompiled_agent import download_precompiled_agent_release
from app.utils.build_host import get_build_executor_config
from app.utils.build_executor import build_executor_display_name, ensure_build_executor_configured
from app.utils.cross_compile import CrossCompiler, TargetMetadata, can_cross_compile_target
from app.utils.versions import current_agent_version, get_versions
from .utils import find_nim_v2, find_nimbase_file, get_fresh_frame


PRECOMPILED_AGENT_ENV = "FRAMEOS_AGENT_PRECOMPILED"
AGENT_SOURCE_BUILD_APT_PACKAGES = ("build-essential", "libssl-dev")
AGENT_BINARY = "frameos_agent"
REPO_ROOT = Path(__file__).resolve().parents[3]


def get_build_host_config(*args, **kwargs):  # noqa: ANN002, ANN003
    """Compatibility shim for older tests monkeypatching this module symbol."""
    from app.utils.build_host import get_build_host_config as _get_build_host_config

    return _get_build_host_config(*args, **kwargs)


def precompiled_agent_enabled() -> bool:
    return os.environ.get(PRECOMPILED_AGENT_ENV, "").strip().lower() not in {
        "0",
        "false",
        "local",
        "no",
        "source",
    }


def agent_build_version() -> str:
    version = get_versions().get("agent")
    if isinstance(version, str) and version:
        return version
    return current_agent_version() or "unknown"


def delayed_agent_restart_command(suffix: str = "manual") -> str:
    safe_suffix = "".join(ch for ch in suffix if ch.isalnum() or ch in {"-", "_"}) or "manual"
    unit = f"frameos-agent-restart-{safe_suffix}"
    restart_script = "sleep 1; systemctl restart frameos_agent.service"
    fallback_script = f"nohup sh -c {shlex.quote(restart_script)} >/dev/null 2>&1 &"
    fallback = f"sudo sh -c {shlex.quote(fallback_script)}"
    return (
        f"(command -v systemd-run >/dev/null 2>&1 && "
        f"sudo systemd-run --quiet --unit={shlex.quote(unit)} --collect /bin/sh -lc "
        f"{shlex.quote(restart_script)}) || {fallback}"
    )


def resolve_agent_task_transport(frame: Frame, transport: RemoteTransport) -> RemoteTransport:
    if transport != "auto":
        return transport

    agent = frame.agent or {}
    if (
        agent.get("agentEnabled")
        and agent.get("agentRunCommands")
        and agent.get("deployWithAgent") is not False
    ):
        return "agent"
    return "ssh"


async def deploy_agent(
    id: int, redis: Redis, *, recompile: bool = False, transport: RemoteTransport = "auto"
) -> None:  # noqa: N802
    await redis.enqueue_job("deploy_agent", id=id, recompile=recompile, transport=transport)


async def deploy_agent_task(
    ctx: dict[str, Any], id: int, recompile: bool = False, transport: RemoteTransport = "auto"
):  # noqa: N802
    db: Session = ctx["db"]
    redis: Redis = ctx["redis"]

    frame: Optional[Frame] = get_fresh_frame(db, id)
    if frame is None:  # keep the early-exit guard
        await log(db, redis, id, "stderr", "Frame not found")
        raise Exception("Frame not found")

    # Workspace ────────────────────────────────────────────────────────────
    try:
        with tempfile.TemporaryDirectory() as tmp:
            resolved_transport = resolve_agent_task_transport(frame, transport)
            deployer = AgentDeployer(db, redis, frame, "", tmp, force_source=recompile, transport=resolved_transport)
            await deployer.run()
    except Exception as e:
        await log(db, redis, id, "stderr", str(e))
        raise

class AgentDeployer(FrameDeployer):
    def __init__(
        self,
        db: Session,
        redis: Redis,
        frame: Frame,
        nim_path: str,
        temp_dir: str,
        *,
        force_source: bool = False,
        transport: RemoteTransport = "ssh",
    ):
        super().__init__(db, redis, frame, nim_path, temp_dir)
        self.force_source = force_source
        self.remote_transport = transport
        self.staged_binary_sha256: str | None = None

    async def run(self) -> None:
        """Main orchestration coroutine (used by global ``deploy_agent_task``)."""
        try:
            with tempfile.TemporaryDirectory() as temp_dir:
                self.temp_dir = temp_dir

                await self.log(
                    "stdout",
                    f"Deploying agent {self.frame.name} with build id {self.build_id} via {self.remote_transport}",
                )

                if self.remote_transport == "agent":
                    await self._verify_agent_transport("before staging")

                # 1. Detect CPU architecture on target
                arch = await self.get_cpu_architecture()
                distro = await self.get_distro()
                distro_version = await self.get_distro_version()

                # 2. Build & deploy the agent (if needed)
                if self._can_deploy_agent():
                    await self.log("stdout", "- Deploying agent")

                    if distro not in {"raspios", "debian", "ubuntu", "buildroot"}:
                        raise Exception(f"Unsupported target distro '{distro}'")

                    await self._deploy_agent(
                        arch=arch,
                        distro=distro,
                        distro_version=distro_version,
                    )
                    await self._setup_agent_service()

                    # 3. Upload *frame.json* for this release
                    await self._upload_frame_json(f"{self._release_dir()}/frame.json")
                    await self._verify_staged_release()

                    if self.remote_transport == "agent":
                        await self._verify_agent_transport("before switching release")

                    # 4. Atomically switch *current* → new release + housekeeping
                    previous_agent_process = await self._agent_service_process_signature()
                    await self._switch_current_release()

                    # Enable + start service
                    if self.remote_transport == "agent":
                        await self._restart_agent_service_via_agent()
                        await self._wait_for_agent_release(previous_agent_process)
                    else:
                        await self.restart_service("frameos_agent")
                        await self._wait_for_agent_release(previous_agent_process)

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

    def _release_dir(self) -> str:
        return f"/srv/frameos/agent/releases/release_{self.build_id}"

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
        shutil.copytree(REPO_ROOT / "frameos" / "agent", source_dir, dirs_exist_ok=True)  # idempotent copy
        os.makedirs(build_dir, exist_ok=True)

        return build_dir, source_dir

    async def _create_local_build_archive(
        self,
        build_dir: str,
        source_dir: str,
        arch: str,
    ) -> str:
        """Compile locally (generate C + scripts), tarball the build directory, return archive path."""
        if not self.nim_path:
            self.nim_path = find_nim_v2()
        debug_opts = "--lineTrace:on" if self.frame.debug else ""
        cpu = await self.arch_to_nim_cpu(arch)
        agent_version = agent_build_version()
        version_option = shlex.quote(f"--define:frameosAgentVersion:{agent_version}")
        cmd = (
            f"cd {source_dir} && nimble install -dy && nimble setup && "
            f"{self.nim_path} compile --os:linux --cpu:{cpu} "
            f"--compileOnly --genScript --nimcache:{build_dir} -d:ssl "
            f"{version_option} {debug_opts} src/frameos_agent.nim 2>&1"
        )

        status, *_ = await exec_local_command(self.db, self.redis, self.frame, cmd)
        if status != 0:
            raise Exception("Failed to generate agent sources")

        # Copy nimbase.h because the generated C depends on it
        nimbase_path = find_nimbase_file(self.nim_path)
        if not nimbase_path:
            raise Exception("nimbase.h not found")
        shutil.copy(nimbase_path, os.path.join(build_dir, "nimbase.h"))
        self._write_agent_c_makefile(build_dir)

        archive_path = os.path.join(self.temp_dir, f"agent_{self.build_id}.tar.gz")
        shutil.make_archive(
            base_name=os.path.join(self.temp_dir, f"agent_{self.build_id}"),
            format="gztar",
            root_dir=self.temp_dir,
            base_dir=f"agent_{self.build_id}",
        )
        return archive_path

    def _write_agent_c_makefile(self, build_dir: str) -> None:
        script_path = self._find_compile_script(build_dir, "compile_frameos_agent.sh")
        linker_flags, compiler_flags = self._extract_compile_flags(script_path, AGENT_BINARY)
        self._write_c_makefile(
            makefile_path=os.path.join(build_dir, "Makefile"),
            template_path=str(REPO_ROOT / "frameos" / "tools" / "nimc.Makefile"),
            output_name=AGENT_BINARY,
            linker_flags=linker_flags,
            compiler_flags=compiler_flags,
        )

    # --------------- DEPLOY ─────────────────────────────────────────--- #

    async def _deploy_agent(self, *, arch: str, distro: str, distro_version: str) -> None:
        """
        Prefer the released binary for the target platform. Fall back to the
        source-generated native build path when no supported release exists.
        """
        if not self.force_source and precompiled_agent_enabled():
            prebuilt_target = resolve_prebuilt_target(distro, distro_version, arch)
            if prebuilt_target:
                try:
                    await self.log("stdout", f"- Trying precompiled FrameOS release for agent on {prebuilt_target}")
                    build_dir = os.path.join(self.temp_dir, f"agent_{self.build_id}")
                    result = await download_precompiled_agent_release(
                        target=prebuilt_target,
                        build_dir=build_dir,
                        temp_dir=self.temp_dir,
                        build_id=self.build_id,
                        logger=self.log,
                    )
                    action = "Using cached" if result.cache_hit else "Downloaded"
                    await self.log("stdout", f"- {action} precompiled FrameOS release for agent: {result.release_url}")
                    await self._stage_agent_binary(result.binary_path)
                    return
                except Exception as exc:
                    await self.log(
                        "stderr",
                        f"- Could not use precompiled agent for {prebuilt_target}: {exc}. Falling back to source build.",
                    )
            else:
                await self.log(
                    "stdout",
                    f"- No precompiled agent target for {distro} {distro_version} on {arch}; falling back to source build",
                )
        else:
            reason = "requested from local development" if self.force_source else f"{PRECOMPILED_AGENT_ENV}=source"
            await self.log("stdout", f"- {reason}; building agent from source")

        await self._deploy_agent_from_source(arch, distro=distro, distro_version=distro_version)

    async def _deploy_agent_from_source(self, arch: str, *, distro: str, distro_version: str) -> None:
        """
        Build generated agent sources locally, cross-compile them when possible,
        and fall back to native compilation on the device when needed.
        """
        build_dir, source_dir = self._create_agent_build_folders()
        archive_path = await self._create_local_build_archive(build_dir, source_dir, arch)

        cross_compiled = await self._try_cross_compile_agent(
            build_dir=build_dir,
            source_dir=source_dir,
            arch=arch,
            distro=distro,
            distro_version=distro_version,
        )
        if cross_compiled:
            return

        await self._ensure_agent_source_build_dependencies(distro)
        await self._ensure_agent_directories()

        with open(archive_path, "rb") as fh:
            archive_data = fh.read()
        await upload_file(
            self.db,
            self.redis,
            self.frame,
            f"/srv/frameos/agent/build/agent_{self.build_id}.tar.gz",
            archive_data,
            timeout=1800,
            transport=self.remote_transport,
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
            f"cp /srv/frameos/agent/build/agent_{self.build_id}/frameos_agent "
            f"{self._release_dir()}/frameos_agent"
        )
        await self.exec_command(f"chmod +x {self._release_dir()}/frameos_agent")

    async def _try_cross_compile_agent(
        self,
        *,
        build_dir: str,
        source_dir: str,
        arch: str,
        distro: str,
        distro_version: str,
    ) -> bool:
        project_id = getattr(self.frame, "project_id", None)
        build_executor = get_build_executor_config(self.db, project_id)
        settings = get_settings_dict(self.db, project_id=project_id) if self.db and project_id is not None else {}
        build_environment_provider = selected_build_environment_provider(settings)
        if build_environment_provider == "none":
            await self.log("stdout", "- Server-side compilation is disabled; building agent on the device")
            return False
        if not can_cross_compile_target(arch):
            if build_environment_provider != "none":
                raise RuntimeError(f"Selected build environment cannot cross compile agent for {arch}")
            await self.log(
                "stdout",
                f"- Agent target architecture {arch} does not support cross compilation; building on the device",
            )
            return False

        ensure_build_executor_configured(build_environment_provider, build_executor)
        if build_executor:
            await self.log("stdout", f"- Cross compiling agent via {build_executor_display_name(build_executor)}")
        else:
            await self.log("stdout", "- Cross compiling agent locally")

        try:
            binary_path = await CrossCompiler(
                db=self.db,
                redis=self.redis,
                frame=self.frame,
                deployer=self,
                target=TargetMetadata(arch=arch, distro=distro, version=distro_version),
                temp_dir=self.temp_dir,
                build_dir=build_dir,
                logger=self.log,
                build_host=build_executor,
                output_name=AGENT_BINARY,
                compile_script_name="compile_frameos_agent.sh",
                needs_quickjs=False,
            ).build(source_dir)
        except Exception as exc:  # noqa: BLE001
            if build_environment_provider != "none":
                await self.log("stderr", f"- Agent cross compilation failed ({exc})")
                raise
            await self.log("stderr", f"- Agent cross compilation failed ({exc}); falling back to on-device build")
            return False

        await self.log("stdout", "- Agent cross compilation succeeded; skipping on-device compile")
        await self._stage_agent_binary(binary_path)
        return True

    async def _ensure_agent_source_build_dependencies(self, distro: str) -> None:
        gcc_check = "command -v gcc >/dev/null 2>&1"
        openssl_header_check = "test -e /usr/include/openssl/ssl.h"

        if distro in {"raspios", "debian", "ubuntu"}:
            await self.log("stdout", "- Ensuring agent source-build dependencies on device")
            missing_packages = []
            for pkg in AGENT_SOURCE_BUILD_APT_PACKAGES:
                sanitized_pkg = sanitize_apt_package_name(pkg)
                installed = (
                    await self.exec_command(
                        f"dpkg-query -W -f='${{Status}}' {shlex.quote(sanitized_pkg)} 2>/dev/null | "
                        "grep -q '^install ok installed$'",
                        raise_on_error=False,
                        log_command=False,
                        log_output=False,
                    )
                    == 0
                )
                if not installed:
                    missing_packages.append(sanitized_pkg)

            if missing_packages:
                await self._install_agent_source_build_apt_packages(missing_packages)

            if await self.exec_command(gcc_check, raise_on_error=False, log_command=False, log_output=False) != 0:
                raise RuntimeError(
                    "gcc is still unavailable after installing build-essential; "
                    "install a C compiler on the device before source-building the FrameOS agent"
                )
            if (
                await self.exec_command(
                    openssl_header_check,
                    raise_on_error=False,
                    log_command=False,
                    log_output=False,
                )
                != 0
            ):
                raise RuntimeError(
                    "OpenSSL headers are still unavailable after installing libssl-dev; "
                    "install libssl-dev on the device before source-building the FrameOS agent"
                )
            return

        if await self.exec_command(gcc_check, raise_on_error=False, log_command=False, log_output=False) != 0:
            raise RuntimeError(
                f"Cannot source-build the FrameOS agent on {distro}: gcc is not installed and automatic "
                "package installation is only supported on Debian, Ubuntu, and Raspberry Pi OS"
            )

    async def _install_agent_source_build_apt_packages(self, packages: list[str]) -> None:
        if not packages:
            return

        quoted_packages = " ".join(shlex.quote(pkg) for pkg in packages)
        install_command = f"apt-get install -y {quoted_packages}"
        await self.log("stdout", f"- Installing agent source-build dependencies: {', '.join(packages)}")

        output: list[str] = []
        status = await self.exec_command(
            self._sudo_system_command(install_command),
            raise_on_error=False,
            output=output,
            timeout=1800,
        )
        if status != 0:
            await self.log("stdout", "- Installing agent source-build dependencies failed. Updating apt and retrying.")
            status = await self.exec_command(
                self._sudo_system_command(f"apt-get update && {install_command}"),
                raise_on_error=False,
                timeout=1800,
            )

        if status != 0:
            package_list = ", ".join(packages)
            raise RuntimeError(
                f"Could not install agent source-build dependencies ({package_list}). "
                "Install them on the device or deploy a precompiled agent release instead."
            )

    def _sudo_system_command(self, command: str) -> str:
        inner = f"set -eu; export DEBIAN_FRONTEND=noninteractive; {command}"
        quoted_inner = shlex.quote(inner)

        if self.remote_transport == "agent":
            return (
                "if command -v systemd-run >/dev/null 2>&1; then "
                "sudo -n systemd-run --quiet --wait --pipe --collect /bin/sh -lc "
                f"{quoted_inner}; "
                "else "
                f"sudo -n sh -lc {quoted_inner}; "
                "fi"
            )

        return f"sudo -n sh -lc {quoted_inner}"

    async def _stage_agent_binary(self, binary_path: str) -> None:
        await self._ensure_agent_directories()
        with open(binary_path, "rb") as fh:
            data = fh.read()
        self.staged_binary_sha256 = hashlib.sha256(data).hexdigest()
        remote_binary = f"{self._release_dir()}/frameos_agent"
        await upload_file(
            self.db,
            self.redis,
            self.frame,
            remote_binary,
            data,
            timeout=1800,
            transport=self.remote_transport,
        )
        await self.exec_command(f"chmod +x {remote_binary}")
        await self._verify_uploaded_binary(remote_binary)

    async def _ensure_agent_directories(self) -> None:
        await self.exec_command(
            "mkdir -p "
            "/srv/frameos/agent/build/ "
            "/srv/frameos/agent/logs/ "
            f"{self._release_dir()}"
        )

    # --------------- SYSTEMD SERVICE ----------------------------------- #

    async def _setup_agent_service(self) -> None:
        """Upload and install the systemd service file for the new release."""
        with open("../frameos/agent/frameos_agent.service", "r", encoding="utf-8") as fh:
            service_contents = fh.read().replace("%I", self.frame.ssh_user)

        # Ship service file with the release
        await upload_file(
            self.db,
            self.redis,
            self.frame,
            f"{self._release_dir()}/frameos_agent.service",
            service_contents.encode(),
            transport=self.remote_transport,
        )

        # Activate system-wide
        await self.exec_command(
            f"sudo cp {self._release_dir()}/frameos_agent.service "
            "/etc/systemd/system/frameos_agent.service"
        )
        await self.exec_command("sudo chown root:root /etc/systemd/system/frameos_agent.service")
        await self.exec_command("sudo chmod 644 /etc/systemd/system/frameos_agent.service")

    async def _verify_agent_transport(self, label: str) -> None:
        output: list[str] = []
        await self.log("stdout", f"- Verifying agent command transport ({label})")
        await self.exec_command(
            "printf frameos-agent-transport-ok",
            output=output,
            log_output=False,
            log_command=False,
            timeout=30,
        )
        if "frameos-agent-transport-ok" not in "\n".join(output):
            raise RuntimeError(f"Agent command transport verification failed ({label})")

    async def _verify_uploaded_binary(self, remote_binary: str) -> None:
        if not self.staged_binary_sha256:
            return
        quoted_binary = shlex.quote(remote_binary)
        quoted_sha = shlex.quote(self.staged_binary_sha256)
        await self.exec_command(
            "if command -v sha256sum >/dev/null 2>&1; then "
            f"printf '%s  %s\\n' {quoted_sha} {quoted_binary} | sha256sum -c -; "
            "else echo 'sha256sum unavailable; verified upload size and executable bit only'; fi",
            timeout=120,
        )

    async def _verify_staged_release(self) -> None:
        release_dir = shlex.quote(self._release_dir())
        await self.log("stdout", "- Verifying staged agent release before switching")
        await self.exec_command(
            "set -eu; "
            f"release={release_dir}; "
            'test -d "$release"; '
            'test -s "$release/frameos_agent"; '
            'test -x "$release/frameos_agent"; '
            'test -s "$release/frameos_agent.service"; '
            'test -s "$release/frame.json"; '
            "grep -q '^ExecStart=/srv/frameos/agent/current/frameos_agent$' "
            '"$release/frameos_agent.service"; '
            "echo staged-agent-release-ok",
            timeout=120,
        )

    async def _switch_current_release(self) -> None:
        release_dir = shlex.quote(self._release_dir())
        await self.log("stdout", "- Switching current agent release")
        await self.exec_command(
            "set -eu; "
            "cd /srv/frameos/agent; "
            "rm -f current.next; "
            f"ln -sfn {release_dir} current.next; "
            "(mv -Tf current.next current 2>/dev/null || (rm -rf current && mv current.next current)); "
            'test "$(readlink current)" = '
            f"{release_dir}",
            timeout=120,
        )

    async def _restart_agent_service_via_agent(self) -> None:
        await self.log("stdout", "- Scheduling FrameOS agent restart through the current agent")
        await self.exec_command(
            delayed_agent_restart_command(self.build_id),
            timeout=30,
        )

    async def _agent_service_process_signature(self) -> str | None:
        output: list[str] = []
        await self.exec_command(
            "pid=$(systemctl show -p MainPID --value frameos_agent.service 2>/dev/null || true); "
            'if [ -n "$pid" ] && [ "$pid" != "0" ]; then '
            'start=$(awk \'{print $22}\' "/proc/$pid/stat" 2>/dev/null || true); '
            'printf "%s:%s" "$pid" "$start"; '
            "fi",
            output=output,
            log_output=False,
            log_command=False,
            raise_on_error=False,
            timeout=15,
        )
        signature = "\n".join(output).strip()
        return signature or None

    async def _wait_for_agent_release(self, previous_process_signature: str | None = None) -> None:
        expected_binary = f"{self._release_dir()}/frameos_agent"
        quoted_expected = shlex.quote(expected_binary)
        quoted_previous_process = shlex.quote(previous_process_signature or "")
        deadline = asyncio.get_event_loop().time() + 90
        last_error: Exception | None = None
        await self.log("stdout", "- Waiting for restarted agent to report the new release")

        while asyncio.get_event_loop().time() < deadline:
            output: list[str] = []
            try:
                await self.exec_command(
                    "pid=$(systemctl show -p MainPID --value frameos_agent.service 2>/dev/null || true); "
                    'test -n "$pid"; test "$pid" != "0"; '
                    'start=$(awk \'{print $22}\' "/proc/$pid/stat" 2>/dev/null || true); '
                    'signature="$pid:$start"; '
                    f'[ -z {quoted_previous_process} ] || [ "$signature" != {quoted_previous_process} ]; '
                    f'test "$(readlink -f /proc/$pid/exe 2>/dev/null)" = {quoted_expected}; '
                    "systemctl is-active --quiet frameos_agent.service; "
                    "echo restarted-agent-release-ok",
                    output=output,
                    log_output=False,
                    log_command=False,
                    timeout=15,
                )
                if "restarted-agent-release-ok" in "\n".join(output):
                    await self.log("stdout", "- Restarted agent is running the staged release")
                    return
            except Exception as exc:  # noqa: BLE001
                last_error = exc

            await asyncio.sleep(3)

        raise RuntimeError(f"Restarted agent did not report the staged release: {last_error}")

    # --------------- MISC ------------------------------------------------ #

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
