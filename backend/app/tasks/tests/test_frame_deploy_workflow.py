from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from app.tasks.binary_builder import FrameBinaryPlan
from app.tasks.frame_deploy_workflow import (
    FRAMEOS_AVAILABLE_COMMANDS,
    EmbeddedFullDeployPlan,
    FrameDeployPlan,
    FrameDeployWorkflow,
    FullDeployPlan,
    HelperActionPlan,
    PackagePlan,
    RemoteUpgradePlan,
)
from app.utils.cross_compile import TargetMetadata


class FakeDeployer:
    def __init__(self, installed_packages: set[str] | None = None, existing_paths: set[str] | None = None):
        self.build_id = "build12345678"
        self.installed_packages = installed_packages or set()
        self.existing_paths = existing_paths or set()
        self.success_commands: set[str] = set()

    async def get_distro(self) -> str:
        return "raspios"

    async def get_cpu_architecture(self) -> str:
        return "arm64"

    async def get_distro_version(self) -> str:
        return "bookworm"

    async def get_total_memory_mb(self) -> int:
        return 1024

    async def exec_command(self, command: str, **_kwargs) -> int:
        if command.startswith("dpkg-query -W -f='${Status}' "):
            package_name = command.split("dpkg-query -W -f='${Status}' ", 1)[1].split(" ", 1)[0].strip("'")
            return 0 if package_name in self.installed_packages else 1
        if command.startswith(
            "test -f /boot/config.txt && grep -Eq '^(kernel=Image|start_file=|fixup_file=)' /boot/config.txt"
        ):
            return 0 if "/boot/config.txt:buildroot" in self.existing_paths else 1
        if command in self.success_commands:
            return 0
        if command.startswith("grep -q ") or command.startswith("test -f /etc/cron.d/frameos-reboot && grep -Fxq "):
            return 1
        if command.startswith("command -v raspi-config > /dev/null && sudo raspi-config nonint get_"):
            return 1
        if command.startswith("systemctl is-enabled ") or command.startswith("systemctl is-active "):
            return 1
        if command.startswith("test -f "):
            path = command.removeprefix("test -f ").strip("'")
            return 0 if path in self.existing_paths else 1
        if command.startswith("test -e "):
            path = command.removeprefix("test -e ").strip("'")
            return 0 if path in self.existing_paths else 1
        raise AssertionError(f"Unexpected command: {command}")


class RecordingDeployer(FakeDeployer):
    def __init__(self):
        super().__init__()
        self.commands: list[str] = []
        self.restarted_services: list[str] = []
        self.logs: list[tuple[str, str]] = []
        self.atomic_uploads: list[tuple[str, bool]] = []
        self.setup_exit_code = 0
        self.setup_output: list[str] = []
        self.root_read_only = False

    async def exec_command(self, command: str, **kwargs) -> int:
        self.commands.append(command)
        if command.startswith("awk '$2 == \"/\" "):
            return 0 if self.root_read_only else 1
        if (
            "./frameos setup" in command
            and (
                "/srv/frameos/releases/release_" in command
                or "/srv/frameos/current" in command
            )
        ):
            output = kwargs.get("output")
            if output is not None:
                output.extend(self.setup_output)
            return self.setup_exit_code
        if command.startswith('grep -q "^dtoverlay=vc4-kms-v3d" '):
            return 1
        if "frameos-firstboot-setup.service" in command or "frameos-setup-reset.sh" in command:
            return 1
        return 0

    async def run_command(self, command: str, **_kwargs) -> tuple[int, str, str]:
        self.commands.append(command)
        if "frameos-firstboot-setup.service" in command or "frameos-setup-reset.sh" in command:
            return 1, "", ""
        return 0, "", ""

    async def restart_service(self, service: str) -> None:
        self.restarted_services.append(service)

    async def log(self, log_type: str, message: str) -> None:
        self.logs.append((log_type, message))

    async def _upload_frame_json_atomically(self, path: str) -> None:
        self.atomic_uploads.append((path, False))

    async def _upload_scenes_json_atomically(self, path: str, gzip: bool = False) -> None:
        self.atomic_uploads.append((path, gzip))

    async def _upload_all_scenes_json_atomically(self, path: str, gzip: bool = False) -> None:
        self.atomic_uploads.append((path, gzip))


class FakeBinaryBuilder:
    async def plan_build(self, **_kwargs) -> FrameBinaryPlan:
        return FrameBinaryPlan(
            build_id="build12345678",
            target=TargetMetadata(arch="arm64", distro="raspios", version="bookworm"),
            compilation_mode="static",
            allow_cross_compile=True,
            force_cross_compile=False,
            cross_compile_supported=True,
            build_host_configured=False,
            will_attempt_cross_compile=True,
            prebuilt_entry=None,
            prebuilt_target="debian-bookworm-arm64",
        )


class FakePrecompiledBinaryBuilder:
    async def plan_build(self, **_kwargs) -> FrameBinaryPlan:
        return FrameBinaryPlan(
            build_id="build12345678",
            target=TargetMetadata(arch="arm64", distro="raspios", version="bookworm"),
            compilation_mode="precompiled",
            allow_cross_compile=True,
            force_cross_compile=False,
            cross_compile_supported=True,
            build_host_configured=False,
            will_attempt_cross_compile=False,
            prebuilt_entry=None,
            prebuilt_target="debian-bookworm-arm64",
            will_attempt_precompiled=True,
            precompiled_release_url="https://example.test/frameos.tar.gz",
        )


@pytest.mark.asyncio
async def test_plan_fast_for_embedded_uses_http_scene_reload_plan():
    class NoDistroDeployer(FakeDeployer):
        async def get_distro(self) -> str:
            raise AssertionError("embedded fast plan should not probe Linux distro")

    frame = SimpleNamespace(
        id=53,
        name="ESPvaarikas",
        mode="embedded",
        last_successful_deploy=None,
        to_dict=lambda: {"id": 53, "name": "ESPvaarikas", "mode": "embedded"},
    )
    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=NoDistroDeployer(),
        temp_dir="",
        binary_builder=FakeBinaryBuilder(),
    )

    plan = await workflow.plan("fast")

    assert plan.fast_deploy is not None
    assert plan.fast_deploy.action == "http_upload_scenes_reload"
    assert plan.frame_dict["mode"] == "embedded"
    assert plan.frame_dict["frame_sync_current_revision"].startswith("deploy-sha256-")
    assert plan.frame_dict["frame_sync_deployed_revision"] == plan.frame_dict["frame_sync_current_revision"]
    assert plan.full_deploy is None


@pytest.mark.asyncio
async def test_full_deploy_skips_authorized_keys_when_remote_is_transport(monkeypatch: pytest.MonkeyPatch):
    frame = SimpleNamespace(
        id=28,
        name="AgentFrame",
        agent={"agentEnabled": True, "agentRunCommands": True, "deployWithAgent": True},
        to_dict=lambda: {"id": 28, "name": "AgentFrame"},
    )
    deployer = RecordingDeployer()
    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=deployer,
        temp_dir="",
        binary_builder=FakeBinaryBuilder(),
    )
    full_plan = FullDeployPlan(
        target={},
        low_memory=False,
        drivers=[],
        binary_plan=await FakeBinaryBuilder().plan_build(),
        selected_public_keys=["ssh-ed25519 AAAA test"],
        known_public_keys=[],
        ssh_keys_need_install=True,
    )

    async def fail_install_authorized_keys(*_args, **_kwargs):
        raise AssertionError("authorized_keys should not be installed during remote deploy")

    monkeypatch.setattr("app.tasks.frame_deploy_workflow._install_authorized_keys", fail_install_authorized_keys)

    await workflow._install_authorized_keys_for_full_deploy(full_plan)

    assert deployer.logs == [("stdout", "🔷 Remote deploy selected; skipping SSH authorized_keys install")]


@pytest.mark.asyncio
async def test_full_plan_includes_remote_upgrade(monkeypatch: pytest.MonkeyPatch):
    frame = SimpleNamespace(
        id=29,
        name="RemoteUpgradeFrame",
        ssh_keys=[],
        rpios={},
        reboot=None,
        agent={
            "agentEnabled": True,
            "agentRunCommands": True,
            "agentSharedSecret": "secret",
            "agentVersion": "2026.1.1",
            "deployWithAgent": True,
        },
        last_successful_deploy={"frameos_version": "9.9.9"},
        last_successful_deploy_at="2026-01-01T00:00:00+00:00",
        to_dict=lambda: {"id": 29, "name": "RemoteUpgradeFrame"},
    )
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.current_remote_version", lambda: "2026.2.0")
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.drivers_for_frame", lambda _frame: {})
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.get_settings_dict", lambda _db, project_id=None: {})
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.select_ssh_keys_for_frame", lambda _frame, _settings: [])
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.normalize_ssh_keys", lambda _settings: [])

    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=FakeDeployer(),
        temp_dir="",
        binary_builder=FakeBinaryBuilder(),
    )

    plan = await workflow.plan("full")

    assert plan.full_deploy is not None
    assert plan.full_deploy.remote_upgrade == RemoteUpgradePlan(
        previous_version="2026.1.1",
        current_version="2026.2.0",
        transport="remote",
    )
    assert plan.full_deploy.to_dict()["remote_upgrade"] == {
        "previous_version": "2026.1.1",
        "current_version": "2026.2.0",
        "transport": "remote",
    }
    assert any("FrameOS Remote 2026.1.1 -> 2026.2.0" in note for note in plan.notes)


@pytest.mark.asyncio
async def test_full_deploy_runs_remote_upgrade_with_planned_transport(monkeypatch: pytest.MonkeyPatch):
    frame = SimpleNamespace(
        id=30,
        name="RemoteUpgradeFrame",
        agent={
            "agentEnabled": True,
            "agentRunCommands": True,
            "agentSharedSecret": "secret",
            "agentVersion": "2026.1.1",
            "deployWithAgent": True,
        },
    )
    deployer = RecordingDeployer()
    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=deployer,
        temp_dir="/tmp/frameos-test",
        binary_builder=FakeBinaryBuilder(),
    )
    remote_runs: list[tuple[int, str, str]] = []

    class FakeRemoteDeployer:
        def __init__(self, _db, _redis, remote_frame, _nim_path, temp_dir, *, transport):
            self.remote_frame = remote_frame
            self.temp_dir = temp_dir
            self.transport = transport

        async def run(self):
            remote_runs.append((self.remote_frame.id, self.temp_dir, self.transport))

    monkeypatch.setattr("app.tasks.frame_deploy_workflow.current_remote_version", lambda: "2026.2.0")
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.RemoteDeployer", FakeRemoteDeployer)
    full_plan = FullDeployPlan(
        target={},
        low_memory=False,
        drivers=[],
        binary_plan=await FakeBinaryBuilder().plan_build(),
        remote_upgrade=RemoteUpgradePlan(
            previous_version="2026.1.1",
            current_version="2026.2.0",
            transport="remote",
        ),
    )

    await workflow._deploy_remote_for_full_deploy_if_needed(full_plan)

    assert remote_runs == [(30, "/tmp/frameos-test", "remote")]
    assert deployer.logs == [
        ("stdout", "🔷 Updating FrameOS Remote 2026.1.1 -> 2026.2.0 before FrameOS full deploy")
    ]


@pytest.mark.asyncio
async def test_full_plan_defaults_to_precompiled(monkeypatch: pytest.MonkeyPatch):
    captured_modes: list[str] = []

    class CapturingBinaryBuilder(FakeBinaryBuilder):
        async def plan_build(self, **kwargs) -> FrameBinaryPlan:
            captured_modes.append(kwargs["compilation_mode"])
            return await super().plan_build(**kwargs)

    frame = SimpleNamespace(
        id=2,
        name="StaticDefault",
        ssh_keys=[],
        rpios={"crossCompilation": "auto"},
        reboot=None,
        last_successful_deploy={"frameos_version": "9.9.9"},
        last_successful_deploy_at="2026-01-01T00:00:00+00:00",
        to_dict=lambda: {"id": 2, "name": "StaticDefault"},
    )
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.drivers_for_frame", lambda _frame: {})
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.get_settings_dict", lambda _db, project_id=None: {})
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.select_ssh_keys_for_frame", lambda _frame, _settings: [])
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.normalize_ssh_keys", lambda _settings: [])

    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=FakeDeployer(),
        temp_dir="",
        binary_builder=CapturingBinaryBuilder(),
    )

    await workflow.plan("full")

    assert captured_modes == ["precompiled"]


@pytest.mark.asyncio
async def test_full_plan_ignores_legacy_frame_cross_compilation_override(monkeypatch: pytest.MonkeyPatch):
    captured_kwargs: list[dict] = []

    class CapturingBinaryBuilder(FakeBinaryBuilder):
        async def plan_build(self, **kwargs) -> FrameBinaryPlan:
            captured_kwargs.append(kwargs)
            return FrameBinaryPlan(
                build_id="build12345678",
                target=TargetMetadata(arch="arm64", distro="raspios", version="bookworm"),
                compilation_mode="static",
                allow_cross_compile=kwargs["allow_cross_compile"],
                force_cross_compile=kwargs["force_cross_compile"],
                cross_compile_supported=True,
                build_host_configured=False,
                will_attempt_cross_compile=False,
                prebuilt_entry=None,
                prebuilt_target="debian-bookworm-arm64",
                allow_on_device_fallback=kwargs["allow_on_device_fallback"],
            )

    frame = SimpleNamespace(
        id=22,
        name="LegacyCrossOverride",
        ssh_keys=[],
        rpios={"crossCompilation": "always"},
        reboot=None,
        last_successful_deploy={"frameos_version": "9.9.9"},
        last_successful_deploy_at="2026-01-01T00:00:00+00:00",
        to_dict=lambda: {"id": 22, "name": "LegacyCrossOverride"},
    )
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.drivers_for_frame", lambda _frame: {})
    monkeypatch.setattr(
        "app.tasks.frame_deploy_workflow.get_settings_dict",
        lambda _db, project_id=None: {"buildEnvironment": {"provider": "none"}},
    )
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.select_ssh_keys_for_frame", lambda _frame, _settings: [])
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.normalize_ssh_keys", lambda _settings: [])

    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=FakeDeployer(),
        temp_dir="",
        binary_builder=CapturingBinaryBuilder(),
    )

    plan = await workflow.plan("full")

    assert captured_kwargs == [
        {
            "allow_cross_compile": False,
            "force_cross_compile": False,
            "allow_on_device_fallback": True,
            "compilation_mode": "precompiled",
        }
    ]
    assert "Cross compilation setting: global" in plan.notes


@pytest.mark.asyncio
async def test_full_plan_supports_buildroot_without_remote_apt(monkeypatch: pytest.MonkeyPatch):
    captured_kwargs: list[dict] = []

    class BuildrootDeployer(FakeDeployer):
        async def get_distro(self) -> str:
            return "buildroot"

        async def get_cpu_architecture(self) -> str:
            return "aarch64"

        async def get_distro_version(self) -> str:
            return "22.04"

        async def get_total_memory_mb(self) -> int:
            return 512

    class BuildrootBinaryBuilder(FakeBinaryBuilder):
        async def plan_build(self, **kwargs) -> FrameBinaryPlan:
            captured_kwargs.append(kwargs)
            return FrameBinaryPlan(
                build_id="build12345678",
                target=TargetMetadata(arch="aarch64", distro="buildroot", version="22.04"),
                compilation_mode="static",
                allow_cross_compile=kwargs["allow_cross_compile"],
                force_cross_compile=kwargs["force_cross_compile"],
                cross_compile_supported=True,
                build_host_configured=False,
                will_attempt_cross_compile=True,
                prebuilt_entry=None,
                prebuilt_target=None,
            )

    frame = SimpleNamespace(
        id=29,
        name="BuildrootFull",
        mode="buildroot",
        ssh_keys=[],
        buildroot={"compilationMode": "static"},
        rpios={"crossCompilation": "never"},
        reboot=None,
        last_successful_deploy={"frameos_version": "9.9.9"},
        last_successful_deploy_at="2026-01-01T00:00:00+00:00",
        to_dict=lambda: {"id": 29, "name": "BuildrootFull", "mode": "buildroot"},
    )
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.drivers_for_frame", lambda _frame: {"waveshare": SimpleNamespace()})
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.get_settings_dict", lambda _db, project_id=None: {})
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.select_ssh_keys_for_frame", lambda _frame, _settings: [])
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.normalize_ssh_keys", lambda _settings: [])

    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=BuildrootDeployer(),
        temp_dir="",
        binary_builder=BuildrootBinaryBuilder(),
    )

    plan = await workflow.plan("full")

    assert captured_kwargs == [
            {
                "allow_cross_compile": True,
                "force_cross_compile": True,
                "allow_on_device_fallback": False,
                "compilation_mode": "static",
            }
        ]
    assert plan.full_deploy is not None
    assert plan.full_deploy.target["distro"] == "buildroot"
    assert plan.full_deploy.package_plans == []
    assert plan.full_deploy.package_alternatives == []
    assert plan.full_deploy.remote_build_fallback_package_plans == []
    assert plan.full_deploy.quickjs_required_if_remote_build is False


@pytest.mark.asyncio
async def test_full_plan_buildroot_default_uses_precompiled_without_build_environment(
    monkeypatch: pytest.MonkeyPatch,
):
    captured_kwargs: list[dict] = []

    class BuildrootDeployer(FakeDeployer):
        async def get_distro(self) -> str:
            return "buildroot"

        async def get_cpu_architecture(self) -> str:
            return "aarch64"

        async def get_distro_version(self) -> str:
            return "2025.02.13"

        async def get_total_memory_mb(self) -> int:
            return 512

    class BuildrootPrecompiledBinaryBuilder(FakeBinaryBuilder):
        async def plan_build(self, **kwargs) -> FrameBinaryPlan:
            captured_kwargs.append(kwargs)
            return FrameBinaryPlan(
                build_id="build12345678",
                target=TargetMetadata(arch="aarch64", distro="buildroot", version="2025.02.13"),
                compilation_mode="precompiled",
                allow_cross_compile=kwargs["allow_cross_compile"],
                force_cross_compile=kwargs["force_cross_compile"],
                cross_compile_supported=True,
                build_host_configured=False,
                will_attempt_cross_compile=False,
                prebuilt_entry=None,
                prebuilt_target="debian-bookworm-arm64",
                requested_compilation_mode="precompiled",
                allow_on_device_fallback=kwargs["allow_on_device_fallback"],
                will_attempt_precompiled=True,
                precompiled_release_url="https://example.test/frameos.tar.gz",
            )

    frame = SimpleNamespace(
        id=31,
        name="BuildrootPrecompiled",
        mode="buildroot",
        ssh_keys=[],
        buildroot={},
        rpios={"crossCompilation": "never"},
        reboot=None,
        last_successful_deploy={"frameos_version": "9.9.9"},
        last_successful_deploy_at="2026-01-01T00:00:00+00:00",
        to_dict=lambda: {"id": 31, "name": "BuildrootPrecompiled", "mode": "buildroot"},
    )
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.drivers_for_frame", lambda _frame: {})
    monkeypatch.setattr(
        "app.tasks.frame_deploy_workflow.get_settings_dict",
        lambda _db, project_id=None: {"buildEnvironment": {"provider": "none"}},
    )
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.select_ssh_keys_for_frame", lambda _frame, _settings: [])
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.normalize_ssh_keys", lambda _settings: [])

    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=BuildrootDeployer(),
        temp_dir="",
        binary_builder=BuildrootPrecompiledBinaryBuilder(),
    )

    plan = await workflow.plan("full")

    assert captured_kwargs == [
        {
            "allow_cross_compile": False,
            "force_cross_compile": False,
            "allow_on_device_fallback": False,
            "compilation_mode": "precompiled",
        }
    ]
    assert plan.full_deploy is not None
    assert plan.full_deploy.binary_plan.will_attempt_precompiled is True
    assert plan.full_deploy.binary_plan.prebuilt_target == "debian-bookworm-arm64"
    assert plan.full_deploy.package_plans == []
    assert plan.full_deploy.remote_build_fallback_package_plans == []


@pytest.mark.asyncio
async def test_full_plan_buildroot_source_fallback_requires_build_environment(
    monkeypatch: pytest.MonkeyPatch,
):
    class BuildrootDeployer(FakeDeployer):
        async def get_distro(self) -> str:
            return "buildroot"

        async def get_cpu_architecture(self) -> str:
            return "aarch64"

        async def get_distro_version(self) -> str:
            return "2025.02.13"

        async def get_total_memory_mb(self) -> int:
            return 512

    class BuildrootSourceFallbackBinaryBuilder(FakeBinaryBuilder):
        async def plan_build(self, **kwargs) -> FrameBinaryPlan:
            return FrameBinaryPlan(
                build_id="build12345678",
                target=TargetMetadata(arch="aarch64", distro="buildroot", version="2025.02.13"),
                compilation_mode="static",
                allow_cross_compile=kwargs["allow_cross_compile"],
                force_cross_compile=kwargs["force_cross_compile"],
                cross_compile_supported=True,
                build_host_configured=False,
                will_attempt_cross_compile=False,
                prebuilt_entry=None,
                prebuilt_target="debian-bookworm-arm64",
                requested_compilation_mode="precompiled",
                allow_on_device_fallback=kwargs["allow_on_device_fallback"],
                will_attempt_precompiled=False,
                precompiled_skip_reason="1 compiled scene is configured",
            )

    frame = SimpleNamespace(
        id=32,
        name="BuildrootCompiledScene",
        mode="buildroot",
        ssh_keys=[],
        buildroot={},
        rpios={"crossCompilation": "never"},
        reboot=None,
        last_successful_deploy={"frameos_version": "9.9.9"},
        last_successful_deploy_at="2026-01-01T00:00:00+00:00",
        to_dict=lambda: {"id": 32, "name": "BuildrootCompiledScene", "mode": "buildroot"},
    )
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.drivers_for_frame", lambda _frame: {})
    monkeypatch.setattr(
        "app.tasks.frame_deploy_workflow.get_settings_dict",
        lambda _db, project_id=None: {"buildEnvironment": {"provider": "none"}},
    )
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.select_ssh_keys_for_frame", lambda _frame, _settings: [])
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.normalize_ssh_keys", lambda _settings: [])

    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=BuildrootDeployer(),
        temp_dir="",
        binary_builder=BuildrootSourceFallbackBinaryBuilder(),
    )

    with pytest.raises(RuntimeError, match="Buildroot deploys can use a precompiled FrameOS release only"):
        await workflow.plan("full")


@pytest.mark.asyncio
async def test_full_plan_buildroot_explicit_source_build_requires_build_environment(
    monkeypatch: pytest.MonkeyPatch,
):
    class BuildrootDeployer(FakeDeployer):
        async def get_distro(self) -> str:
            return "buildroot"

        async def get_cpu_architecture(self) -> str:
            return "aarch64"

        async def get_distro_version(self) -> str:
            return "2025.02.13"

        async def get_total_memory_mb(self) -> int:
            return 512

    frame = SimpleNamespace(
        id=33,
        name="BuildrootStatic",
        mode="buildroot",
        ssh_keys=[],
        buildroot={"compilationMode": "static"},
        rpios={"crossCompilation": "never"},
        reboot=None,
        last_successful_deploy={"frameos_version": "9.9.9"},
        last_successful_deploy_at="2026-01-01T00:00:00+00:00",
        to_dict=lambda: {"id": 33, "name": "BuildrootStatic", "mode": "buildroot"},
    )
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.drivers_for_frame", lambda _frame: {})
    monkeypatch.setattr(
        "app.tasks.frame_deploy_workflow.get_settings_dict",
        lambda _db, project_id=None: {"buildEnvironment": {"provider": "none"}},
    )
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.select_ssh_keys_for_frame", lambda _frame, _settings: [])
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.normalize_ssh_keys", lambda _settings: [])

    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=BuildrootDeployer(),
        temp_dir="",
        binary_builder=FakeBinaryBuilder(),
    )

    with pytest.raises(RuntimeError, match="Buildroot source deploys require Docker"):
        await workflow.plan("full")


@pytest.mark.asyncio
async def test_full_plan_corrects_buildroot_mode_when_target_is_ubuntu(monkeypatch: pytest.MonkeyPatch):
    captured_kwargs: list[dict] = []

    class UbuntuDeployer(FakeDeployer):
        def __init__(self):
            super().__init__(installed_packages={"ntp"})
            self.logs: list[tuple[str, str]] = []

        async def get_distro(self) -> str:
            return "ubuntu"

        async def get_cpu_architecture(self) -> str:
            return "aarch64"

        async def get_distro_version(self) -> str:
            return "noble"

        async def log(self, log_type: str, message: str) -> None:
            self.logs.append((log_type, message))

    class UbuntuBinaryBuilder(FakeBinaryBuilder):
        async def plan_build(self, **kwargs) -> FrameBinaryPlan:
            captured_kwargs.append(kwargs)
            return FrameBinaryPlan(
                build_id="build12345678",
                target=TargetMetadata(arch="aarch64", distro="ubuntu", version="noble"),
                compilation_mode="static",
                allow_cross_compile=kwargs["allow_cross_compile"],
                force_cross_compile=kwargs["force_cross_compile"],
                cross_compile_supported=True,
                build_host_configured=False,
                will_attempt_cross_compile=False,
                prebuilt_entry=None,
                prebuilt_target=None,
            )

    frame = SimpleNamespace(
        id=30,
        name="MisconfiguredUbuntu",
        mode="buildroot",
        ssh_user="root",
        ssh_keys=[],
        buildroot={"compilationMode": "static"},
        rpios={"crossCompilation": "never", "compilationMode": "precompiled"},
        reboot=None,
        last_successful_deploy={"frameos_version": "9.9.9"},
        last_successful_deploy_at="2026-01-01T00:00:00+00:00",
        to_dict=lambda: {"id": 30, "name": "MisconfiguredUbuntu", "mode": frame.mode, "ssh_user": frame.ssh_user},
    )
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.drivers_for_frame", lambda _frame: {})
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.get_settings_dict", lambda _db, project_id=None: {})
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.select_ssh_keys_for_frame", lambda _frame, _settings: [])
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.normalize_ssh_keys", lambda _settings: [])

    deployer = UbuntuDeployer()
    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=deployer,
        temp_dir="",
        binary_builder=UbuntuBinaryBuilder(),
    )

    plan = await workflow.plan("full")

    assert frame.mode == "rpios"
    assert frame.ssh_user == "pi"
    assert plan.frame_dict["mode"] == "rpios"
    assert plan.frame_dict["ssh_user"] == "pi"
    assert captured_kwargs == [
        {
            "allow_cross_compile": True,
            "force_cross_compile": False,
            "allow_on_device_fallback": False,
            "compilation_mode": "precompiled",
        }
    ]
    assert plan.full_deploy is not None
    assert plan.full_deploy.target["distro"] == "ubuntu"
    assert {pkg.name for pkg in plan.full_deploy.package_plans} >= {"hostapd", "build-essential", "caddy"}
    assert deployer.logs == [("stdinfo", "🔷 Detected ubuntu; updating frame deployment mode from buildroot to rpios")]


@pytest.mark.asyncio
async def test_full_plan_maps_the_retired_shared_mode_to_a_single_binary(monkeypatch: pytest.MonkeyPatch):
    captured_modes: list[str] = []

    class CapturingBinaryBuilder(FakeBinaryBuilder):
        async def plan_build(self, **kwargs) -> FrameBinaryPlan:
            captured_modes.append(kwargs["compilation_mode"])
            return await super().plan_build(**kwargs)

    frame = SimpleNamespace(
        id=3,
        name="SharedExplicit",
        ssh_keys=[],
        rpios={"crossCompilation": "auto", "compilationMode": "shared"},
        reboot=None,
        last_successful_deploy={"frameos_version": "9.9.9"},
        last_successful_deploy_at="2026-01-01T00:00:00+00:00",
        to_dict=lambda: {"id": 3, "name": "SharedExplicit"},
    )
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.drivers_for_frame", lambda _frame: {})
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.get_settings_dict", lambda _db, project_id=None: {})
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.select_ssh_keys_for_frame", lambda _frame, _settings: [])
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.normalize_ssh_keys", lambda _settings: [])

    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=FakeDeployer(),
        temp_dir="",
        binary_builder=CapturingBinaryBuilder(),
    )

    await workflow.plan("full")

    assert captured_modes == ["static"]


@pytest.mark.asyncio
async def test_fast_plan_keeps_previous_version_and_marks_restart_for_tls_change():
    frame = SimpleNamespace(
        id=1,
        name="Kitchen",
        https_proxy={"enable": True, "port": 9443, "certs": {}},
        last_successful_deploy={"https_proxy": {"enable": True, "port": 8443, "certs": {}}, "frameos_version": "1.2.3"},
        to_dict=lambda: {"id": 1, "name": "Kitchen", "https_proxy": {"enable": True, "port": 9443, "certs": {}}},
    )
    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=FakeDeployer(),
        temp_dir="",
        binary_builder=FakeBinaryBuilder(),
    )

    plan = await workflow.plan("fast")

    assert plan.fast_deploy is not None
    assert plan.fast_deploy.action == "restart_service"
    assert plan.fast_deploy.tls_settings_changed is True
    assert plan.frame_dict["frameos_version"] == "1.2.3"


@pytest.mark.asyncio
async def test_combined_plan_includes_fast_and_full_sections(monkeypatch: pytest.MonkeyPatch):
    frame = SimpleNamespace(
        id=11,
        name="Combined",
        rpios={"crossCompilation": "auto"},
        https_proxy={"enable": False},
        reboot=None,
        last_successful_deploy={"frameos_version": "9.9.9", "https_proxy": {"enable": False}},
        last_successful_deploy_at="2026-01-01T00:00:00+00:00",
        to_dict=lambda: {"id": 11, "name": "Combined", "https_proxy": {"enable": False}},
    )
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.drivers_for_frame", lambda _frame: {})
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.get_settings_dict", lambda _db, project_id=None: {})
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.select_ssh_keys_for_frame", lambda _frame, _settings: [])
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.normalize_ssh_keys", lambda _settings: [])

    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=FakeDeployer(),
        temp_dir="",
        binary_builder=FakeBinaryBuilder(),
    )

    plan = await workflow.plan("combined")

    assert plan.mode == "combined"
    assert plan.fast_deploy is not None
    assert plan.full_deploy is not None
    assert any("Fast deploy keeps the frame configuration" in note for note in plan.notes)
    assert any("Full deploy additionally rebuilds or uploads the FrameOS binary" in note for note in plan.notes)


@pytest.mark.asyncio
async def test_full_plan_reports_installed_state_and_remote_build_dependencies(monkeypatch: pytest.MonkeyPatch):
    frame = SimpleNamespace(
        id=7,
        name="Office",
        ssh_keys=["main"],
        rpios={"crossCompilation": "auto"},
        reboot=None,
        last_successful_deploy={"frameos_version": "9.9.9", "ssh_keys": ["main"]},
        last_successful_deploy_at="2026-01-01T00:00:00+00:00",
        to_dict=lambda: {"id": 7, "name": "Office"},
    )
    deployer = FakeDeployer(
        installed_packages={"build-essential", "ntp", "python3-pip"},
        existing_paths={"/srv/frameos/vendor/quickjs/quickjs-2026-06-04"},
    )
    deployer.success_commands.update(
        {
            "systemctl is-enabled caddy.service >/dev/null 2>&1 || systemctl is-active caddy.service >/dev/null 2>&1",
        }
    )

    monkeypatch.setattr("app.tasks.frame_deploy_workflow.drivers_for_frame", lambda _frame: {"inkyPython": SimpleNamespace(vendor_folder="inky")})
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.get_settings_dict", lambda _db, project_id=None: {})
    monkeypatch.setattr(
        "app.tasks.frame_deploy_workflow.select_ssh_keys_for_frame",
        lambda _frame, _settings: [{"public": "ssh-ed25519 AAA main"}],
    )
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.normalize_ssh_keys", lambda _settings: [{"public": "ssh-ed25519 AAA main"}])

    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=deployer,
        temp_dir="",
        binary_builder=FakeBinaryBuilder(),
    )

    plan = await workflow.plan("full")

    assert plan.full_deploy is not None
    assert plan.full_deploy.binary_plan.will_attempt_cross_compile is True
    assert plan.full_deploy.quickjs_installed is True
    package_map = {pkg.name: pkg for pkg in plan.full_deploy.package_plans}
    assert package_map["build-essential"].installed is True
    assert "libssl-dev" not in package_map
    assert "libunistring-dev" not in package_map
    assert "libtool" not in package_map
    assert "cmake" not in package_map
    assert "pkg-config" not in package_map
    assert "libatomic-ops-dev" not in package_map
    assert "libicu-dev" not in package_map
    assert "zlib1g-dev" not in package_map
    assert package_map["caddy"].installed is False
    assert package_map["python3-pip"].installed is True
    assert plan.full_deploy.package_alternatives[0].installed_package == "ntp"
    assert plan.full_deploy.dependency_helper_plans == []
    assert [vendor.key for vendor in plan.full_deploy.vendor_sync_plans] == ["inkyPython"]
    assert plan.full_deploy.vendor_sync_plans[0].preserve_remote_paths == ("env", "requirements.txt.sha256sum")
    assert plan.full_deploy.ssh_keys_need_install is False
    assert plan.full_deploy.post_deploy["i2c"]["needs_boot_config_line"] is False
    assert plan.full_deploy.post_deploy["i2c"]["needs_runtime_enable"] is False
    assert plan.full_deploy.post_deploy["spi_action"] == "unchanged"
    assert plan.full_deploy.post_deploy["disable_caddy_service"] is True
    assert plan.full_deploy.post_deploy["bootconfig_changes"] == []
    assert plan.full_deploy.post_deploy["final_action"] == "restart_frameos"


@pytest.mark.asyncio
async def test_full_plan_native_hyperpixel_uses_native_gpio_without_vendor_sync(monkeypatch: pytest.MonkeyPatch):
    frame = SimpleNamespace(
        id=30,
        name="NativeHyperPixel",
        ssh_keys=[],
        rpios={"crossCompilation": "auto", "compilationMode": "precompiled"},
        reboot=None,
        last_successful_deploy={"frameos_version": "9.9.9"},
        last_successful_deploy_at="2026-01-01T00:00:00+00:00",
        to_dict=lambda: {"id": 30, "name": "NativeHyperPixel"},
    )

    monkeypatch.setattr("app.tasks.frame_deploy_workflow.drivers_for_frame", lambda _frame: {"inkyHyperPixel2r": SimpleNamespace()})
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.get_settings_dict", lambda _db, project_id=None: {})
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.select_ssh_keys_for_frame", lambda _frame, _settings: [])
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.normalize_ssh_keys", lambda _settings: [])

    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=FakeDeployer(),
        temp_dir="",
        binary_builder=FakePrecompiledBinaryBuilder(),
    )

    plan = await workflow.plan("full")

    assert plan.full_deploy is not None
    package_names = {pkg.name for pkg in plan.full_deploy.package_plans}
    assert "python3-dev" not in package_names
    assert "python3-pip" not in package_names
    assert "python3-venv" not in package_names
    assert plan.full_deploy.vendor_sync_plans == []


@pytest.mark.asyncio
async def test_full_plan_legacy_hyperpixel_keeps_python_vendor_setup(monkeypatch: pytest.MonkeyPatch):
    frame = SimpleNamespace(
        id=31,
        name="LegacyHyperPixel",
        ssh_keys=[],
        rpios={"crossCompilation": "auto", "compilationMode": "precompiled"},
        reboot=None,
        last_successful_deploy={"frameos_version": "9.9.9"},
        last_successful_deploy_at="2026-01-01T00:00:00+00:00",
        to_dict=lambda: {"id": 31, "name": "LegacyHyperPixel"},
    )

    monkeypatch.setattr(
        "app.tasks.frame_deploy_workflow.drivers_for_frame",
        lambda _frame: {"inkyHyperPixel2rLegacyFb": SimpleNamespace(vendor_folder="inkyHyperPixel2r")},
    )
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.get_settings_dict", lambda _db, project_id=None: {})
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.select_ssh_keys_for_frame", lambda _frame, _settings: [])
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.normalize_ssh_keys", lambda _settings: [])

    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=FakeDeployer(),
        temp_dir="",
        binary_builder=FakePrecompiledBinaryBuilder(),
    )

    plan = await workflow.plan("full")

    assert plan.full_deploy is not None
    package_names = {pkg.name for pkg in plan.full_deploy.package_plans}
    assert "python3-dev" in package_names
    assert "python3-pip" in package_names
    assert "python3-venv" in package_names
    assert [vendor.key for vendor in plan.full_deploy.vendor_sync_plans] == ["inkyHyperPixel2rLegacyFb"]
    assert plan.full_deploy.vendor_sync_plans[0].vendor_folder == "inkyHyperPixel2r"
    assert plan.full_deploy.vendor_sync_plans[0].preserve_remote_paths == ("env", "requirements.txt.sha256sum")


@pytest.mark.asyncio
async def test_full_plan_skips_remote_build_dependencies_for_precompiled(monkeypatch: pytest.MonkeyPatch):
    frame = SimpleNamespace(
        id=17,
        name="PrecompiledFrame",
        ssh_keys=[],
        rpios={"crossCompilation": "auto", "compilationMode": "precompiled"},
        reboot=None,
        last_successful_deploy={"frameos_version": "9.9.9"},
        last_successful_deploy_at="2026-01-01T00:00:00+00:00",
        to_dict=lambda: {"id": 17, "name": "PrecompiledFrame"},
    )
    deployer = FakeDeployer()

    monkeypatch.setattr("app.tasks.frame_deploy_workflow.drivers_for_frame", lambda _frame: {})
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.get_settings_dict", lambda _db, project_id=None: {})
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.select_ssh_keys_for_frame", lambda _frame, _settings: [])
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.normalize_ssh_keys", lambda _settings: [])

    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=deployer,
        temp_dir="",
        binary_builder=FakePrecompiledBinaryBuilder(),
    )

    plan = await workflow.plan("full")

    assert plan.full_deploy is not None
    assert plan.full_deploy.binary_plan.will_attempt_precompiled is True
    assert plan.full_deploy.quickjs_required_if_remote_build is False
    assert plan.full_deploy.remote_build_fallback_package_plans == []
    package_names = {pkg.name for pkg in plan.full_deploy.package_plans}
    assert "build-essential" not in package_names
    assert "libssl-dev" not in package_names
    assert "libunistring-dev" not in package_names
    assert "libtool" not in package_names
    assert "cmake" not in package_names
    assert "pkg-config" not in package_names
    assert "libatomic-ops-dev" not in package_names
    assert "libicu-dev" not in package_names
    assert "zlib1g-dev" not in package_names


@pytest.mark.asyncio
async def test_full_plan_includes_cifs_utils_for_enabled_mountpoints(monkeypatch: pytest.MonkeyPatch):
    frame = SimpleNamespace(
        id=18,
        name="MountedFrame",
        ssh_keys=[],
        rpios={"crossCompilation": "auto", "compilationMode": "precompiled"},
        reboot=None,
        mountpoints={
            "enabled": True,
            "items": [{"enabled": True, "source": "//nas/photos", "target": "/mnt/photos"}],
        },
        last_successful_deploy={"frameos_version": "9.9.9"},
        last_successful_deploy_at="2026-01-01T00:00:00+00:00",
        to_dict=lambda: {"id": 18, "name": "MountedFrame"},
    )
    deployer = FakeDeployer()

    monkeypatch.setattr("app.tasks.frame_deploy_workflow.drivers_for_frame", lambda _frame: {})
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.get_settings_dict", lambda _db, project_id=None: {})
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.select_ssh_keys_for_frame", lambda _frame, _settings: [])
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.normalize_ssh_keys", lambda _settings: [])

    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=deployer,
        temp_dir="",
        binary_builder=FakePrecompiledBinaryBuilder(),
    )

    plan = await workflow.plan("full")

    assert plan.full_deploy is not None
    package_map = {pkg.name: pkg for pkg in plan.full_deploy.package_plans}
    assert package_map["cifs-utils"].reason == "Samba/CIFS mountpoint support"
    assert package_map["cifs-utils"].installed is False


@pytest.mark.asyncio
async def test_full_plan_includes_post_deploy_driver_and_reboot_steps(monkeypatch: pytest.MonkeyPatch):
    frame = SimpleNamespace(
        id=8,
        name="DriverFrame",
        ssh_keys=["main"],
        rpios={"crossCompilation": "auto"},
        reboot={"enabled": "true", "crontab": "5 4 * * *", "type": "raspberry"},
        last_successful_deploy_at=None,
        last_successful_deploy={"frameos_version": "9.9.9"},
        to_dict=lambda: {"id": 8, "name": "DriverFrame"},
    )
    deployer = FakeDeployer(existing_paths={"/boot/firmware/config.txt"})
    deployer.success_commands.update(
        {
            'command -v raspi-config > /dev/null && sudo raspi-config nonint get_i2c | grep -q "1"',
            'command -v raspi-config > /dev/null && sudo raspi-config nonint get_spi | grep -q "1"',
            "systemctl is-enabled caddy.service >/dev/null 2>&1 || systemctl is-active caddy.service >/dev/null 2>&1",
            "systemctl is-enabled userconfig >/dev/null 2>&1",
        }
    )

    monkeypatch.setattr(
        "app.tasks.frame_deploy_workflow.drivers_for_frame",
        lambda _frame: {
            "i2c": SimpleNamespace(),
            "spi": SimpleNamespace(),
            "bootconfig": SimpleNamespace(lines=["dtoverlay=vc4-kms-v3d", "#dtoverlay=old-setting"]),
        },
    )
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.get_settings_dict", lambda _db, project_id=None: {})
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.select_ssh_keys_for_frame", lambda _frame, _settings: [])
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.normalize_ssh_keys", lambda _settings: [])

    class LowMemoryBinaryBuilder(FakeBinaryBuilder):
        async def plan_build(self, **_kwargs) -> FrameBinaryPlan:
            return await super().plan_build(**_kwargs)

    class LowMemoryDeployer(FakeDeployer):
        async def get_total_memory_mb(self) -> int:
            return 256

    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=LowMemoryDeployer(existing_paths={"/boot/firmware/config.txt"}),
        temp_dir="",
        binary_builder=LowMemoryBinaryBuilder(),
    )
    workflow.deployer.success_commands.update(
        {
            'command -v raspi-config > /dev/null && sudo raspi-config nonint get_i2c | grep -q "1"',
            'command -v raspi-config > /dev/null && sudo raspi-config nonint get_spi | grep -q "1"',
            "systemctl is-enabled caddy.service >/dev/null 2>&1 || systemctl is-active caddy.service >/dev/null 2>&1",
            "systemctl is-enabled userconfig >/dev/null 2>&1",
        }
    )

    plan = await workflow.plan("full")

    assert plan.full_deploy is not None
    post_deploy = plan.full_deploy.post_deploy
    assert post_deploy["boot_config_path"] == "/boot/firmware/config.txt"
    assert post_deploy["i2c"] == {
        "requested": True,
        "needs_boot_config_line": True,
        "needs_runtime_enable": True,
    }
    assert post_deploy["spi_action"] == "enable"
    assert post_deploy["low_memory_masks_apt_daily"] is True
    assert post_deploy["reboot_schedule"] == {
        "enabled": True,
        "crontab": "5 4 * * *",
        "type": "raspberry",
        "command": "/sbin/shutdown -r now",
        "needs_update": True,
        "needs_remove": False,
    }
    assert post_deploy["bootconfig_changes"] == [
        {"action": "add", "line": "dtoverlay=vc4-kms-v3d"},
    ]
    assert post_deploy["disable_userconfig"] is True
    assert post_deploy["disable_caddy_service"] is True
    assert post_deploy["final_action"] == "reboot"


@pytest.mark.asyncio
async def test_post_deploy_plan_prefers_buildroot_active_boot_config():
    frame = SimpleNamespace(
        id=9,
        name="BuildrootBootConfigFrame",
        reboot=None,
        last_successful_deploy_at="2026-01-01T00:00:00+00:00",
    )
    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=FakeDeployer(existing_paths={"/boot/config.txt:buildroot", "/boot/firmware/config.txt"}),
        temp_dir="",
        binary_builder=FakeBinaryBuilder(),
    )

    post_deploy = await workflow._plan_post_deploy_cleanup(drivers={}, low_memory=False)

    assert post_deploy["boot_config_path"] == "/boot/config.txt"


@pytest.mark.asyncio
async def test_post_deploy_plan_normalizes_legacy_reboot_crontab():
    frame = SimpleNamespace(
        id=9,
        name="LegacyCronFrame",
        reboot={"enabled": "true", "crontab": "4 0 * * *", "type": "frameos"},
        last_successful_deploy_at=None,
    )
    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=FakeDeployer(),
        temp_dir="",
        binary_builder=FakeBinaryBuilder(),
    )

    post_deploy = await workflow._plan_post_deploy_cleanup(drivers={}, low_memory=False)

    assert post_deploy["reboot_schedule"] == {
        "enabled": True,
        "crontab": "0 4 * * *",
        "type": "frameos",
        "command": "systemctl restart frameos.service",
        "needs_update": True,
        "needs_remove": False,
    }


@pytest.mark.asyncio
async def test_full_plan_tracks_helper_actions_and_fallback_packages(monkeypatch: pytest.MonkeyPatch):
    frame = SimpleNamespace(
        id=12,
        name="FallbackFrame",
        ssh_keys=[],
        rpios={"crossCompilation": "auto"},
        reboot=None,
        last_successful_deploy={"frameos_version": "9.9.9"},
        last_successful_deploy_at="2026-01-01T00:00:00+00:00",
        to_dict=lambda: {"id": 12, "name": "FallbackFrame"},
    )
    deployer = FakeDeployer()

    monkeypatch.setattr("app.tasks.frame_deploy_workflow.drivers_for_frame", lambda _frame: {})
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.get_settings_dict", lambda _db, project_id=None: {})
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.select_ssh_keys_for_frame", lambda _frame, _settings: [])
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.normalize_ssh_keys", lambda _settings: [])

    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=deployer,
        temp_dir="",
        binary_builder=FakeBinaryBuilder(),
    )

    plan = await workflow.plan("full")

    assert plan.full_deploy is not None
    assert [helper.helper for helper in plan.full_deploy.dependency_helper_plans] == ["ensure_ntp"]
    assert [pkg.name for pkg in plan.full_deploy.remote_build_fallback_package_plans] == ["libssl-dev"]
    assert "libssl-dev" not in {pkg.name for pkg in plan.full_deploy.package_plans}


@pytest.mark.asyncio
async def test_install_planned_remote_dependencies_uses_helper_and_fallback_plans(monkeypatch: pytest.MonkeyPatch):
    frame = SimpleNamespace(
        id=13,
        name="DependencyFrame",
        reboot=None,
        last_successful_deploy={"frameos_version": "9.9.9"},
        last_successful_deploy_at="2026-01-01T00:00:00+00:00",
        to_dict=lambda: {"id": 13, "name": "DependencyFrame"},
    )
    deployer = RecordingDeployer()
    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=deployer,
        temp_dir="",
        binary_builder=FakeBinaryBuilder(),
    )

    helper_calls: list[str] = []
    package_calls: list[tuple[str, str | None]] = []

    async def fake_ensure_ntp_installed(_deployer):
        helper_calls.append("ensure_ntp")

    async def fake_install_if_necessary(_deployer, pkg: str, raise_on_error: bool = True, run_after_install: str | None = None):
        package_calls.append((pkg, run_after_install))
        return 0

    monkeypatch.setattr("app.tasks.frame_deploy_workflow.ensure_ntp_installed", fake_ensure_ntp_installed)
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.install_if_necessary", fake_install_if_necessary)

    full_plan = FullDeployPlan(
        target={},
        low_memory=False,
        drivers=[],
        binary_plan=await FakeBinaryBuilder().plan_build(),
        dependency_helper_plans=[HelperActionPlan(helper="ensure_ntp", reason="time synchronization")],
        package_plans=[PackagePlan(name="caddy", reason="proxy", installed=False)],
        remote_build_fallback_package_plans=[PackagePlan(name="libssl-dev", reason="fallback", installed=False)],
    )

    await workflow._install_planned_remote_dependencies(full_plan=full_plan, cross_compiled=False)

    assert helper_calls == ["ensure_ntp"]
    assert package_calls == [("caddy", None), ("libssl-dev", None)]




@pytest.mark.asyncio
async def test_run_post_deploy_cleanup_uses_planned_actions_without_recalculating():
    frame = SimpleNamespace(
        id=9,
        name="PlannedFrame",
        reboot={"enabled": "false"},
        last_successful_deploy_at=None,
        last_successful_deploy={"frameos_version": "9.9.9"},
        to_dict=lambda: {"id": 9, "name": "PlannedFrame"},
    )
    deployer = RecordingDeployer()
    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=deployer,
        temp_dir="",
        binary_builder=FakeBinaryBuilder(),
    )

    await workflow._run_post_deploy_cleanup(
        post_deploy={
            "boot_config_path": "/boot/custom.txt",
            "i2c": {
                "requested": True,
                "needs_boot_config_line": True,
                "needs_runtime_enable": True,
            },
            "spi_action": "disable",
            "low_memory_masks_apt_daily": True,
            "reboot_schedule": {
                "enabled": True,
                "crontab": "5 4 * * *",
                "type": "raspberry",
                "command": "/sbin/shutdown -r now",
                "needs_update": True,
                "needs_remove": False,
            },
            "bootconfig_changes": [
                {"action": "add", "line": "dtoverlay=vc4-kms-v3d"},
                {"action": "remove", "line": "dtoverlay=old-setting"},
            ],
            "disable_userconfig": False,
            "disable_caddy_service": True,
            "final_action": "restart_frameos",
        }
    )

    assert all("sudo ./frameos setup" not in command for command in deployer.commands)
    assert any("/boot/custom.txt" in command for command in deployer.commands)
    assert "sudo raspi-config nonint do_spi 1" not in deployer.commands
    assert any("/etc/cron.d/frameos-reboot" in command for command in deployer.commands)
    assert "sudo systemctl daemon-reload" in deployer.commands
    assert "sudo systemctl restart frameos.service" in deployer.commands
    assert "sudo systemctl status frameos.service" in deployer.commands
    assert deployer.restarted_services == []
    assert all("userconfig" not in command for command in deployer.commands)
    assert "sudo reboot" not in deployer.commands


@pytest.mark.asyncio
async def test_run_post_deploy_cleanup_remounts_read_only_root_around_cron_update():
    frame = SimpleNamespace(
        id=9,
        name="BuildrootCleanupFrame",
        reboot={"enabled": "true", "crontab": "0 4 * * *", "type": "frameos"},
        last_successful_deploy_at=None,
        last_successful_deploy={"frameos_version": "9.9.9"},
        to_dict=lambda: {"id": 9, "name": "BuildrootCleanupFrame"},
    )
    deployer = RecordingDeployer()
    deployer.root_read_only = True
    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=deployer,
        temp_dir="",
        binary_builder=FakeBinaryBuilder(),
    )

    await workflow._run_post_deploy_cleanup(
        post_deploy={
            "boot_config_path": "/boot/config.txt",
            "low_memory_masks_apt_daily": False,
            "reboot_schedule": {
                "enabled": True,
                "crontab": "0 4 * * *",
                "type": "frameos",
                "command": "systemctl restart frameos.service",
                "needs_update": True,
                "needs_remove": False,
            },
            "bootconfig_changes": [],
            "disable_userconfig": False,
            "disable_caddy_service": False,
            "final_action": "restart_frameos",
        }
    )

    root_check = next(index for index, command in enumerate(deployer.commands) if command.startswith("awk '$2 == \"/\" "))
    remount_rw = deployer.commands.index("sudo mount -o remount,rw /")
    cron_update = next(index for index, command in enumerate(deployer.commands) if "/etc/cron.d/frameos-reboot" in command)
    sync = deployer.commands.index("sudo sync")
    remount_ro = deployer.commands.index("sudo mount -o remount,ro /")
    restart = deployer.commands.index("sudo systemctl restart frameos.service")
    assert root_check < remount_rw < cron_update < sync < remount_ro < restart
    assert ("stdout", "Root filesystem is read-only; remounting read-write for final cleanup") in deployer.logs
    assert ("stdout", "Restoring root filesystem to read-only after final cleanup") in deployer.logs


@pytest.mark.asyncio
async def test_run_post_deploy_cleanup_uses_host_systemd_for_remote_rootfs_writes():
    frame = SimpleNamespace(
        id=9,
        name="BuildrootRemoteCleanupFrame",
        agent={"agentEnabled": True, "agentRunCommands": True, "deployWithAgent": True},
        reboot={"enabled": "true", "crontab": "0 4 * * *", "type": "frameos"},
        last_successful_deploy_at=None,
        last_successful_deploy={"frameos_version": "9.9.9"},
        to_dict=lambda: {"id": 9, "name": "BuildrootRemoteCleanupFrame"},
    )
    deployer = RecordingDeployer()
    deployer.root_read_only = True
    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=deployer,
        temp_dir="",
        binary_builder=FakeBinaryBuilder(),
    )

    await workflow._run_post_deploy_cleanup(
        post_deploy={
            "boot_config_path": "/boot/config.txt",
            "low_memory_masks_apt_daily": False,
            "reboot_schedule": {
                "enabled": True,
                "crontab": "0 4 * * *",
                "type": "frameos",
                "command": "systemctl restart frameos.service",
                "needs_update": True,
                "needs_remove": False,
            },
            "bootconfig_changes": [],
            "disable_userconfig": False,
            "disable_caddy_service": False,
            "final_action": "restart_frameos",
        }
    )

    host_commands = [command for command in deployer.commands if "systemd-run --quiet --wait --pipe --collect" in command]
    assert any("mount -o remount,rw /" in command for command in host_commands)
    assert any("/etc/cron.d/frameos-reboot" in command for command in host_commands)
    assert any("mount -o remount,ro /" in command for command in host_commands)
    assert not any(command == "sudo mount -o remount,rw /" for command in deployer.commands)


@pytest.mark.asyncio
async def test_run_release_setup_uses_staged_release_and_marks_reboot_when_setup_requires_it():
    frame = SimpleNamespace(
        id=10,
        name="SetupRebootFrame",
        reboot={"enabled": "false"},
        last_successful_deploy_at=None,
        last_successful_deploy={"frameos_version": "9.9.9"},
        to_dict=lambda: {"id": 10, "name": "SetupRebootFrame"},
    )
    deployer = RecordingDeployer()
    deployer.setup_exit_code = 2
    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=deployer,
        temp_dir="",
        binary_builder=FakeBinaryBuilder(),
    )

    post_deploy = {
        "final_action": "restart_frameos",
    }

    await workflow._run_release_setup(
        build_id="build12345678",
        post_deploy=post_deploy,
    )

    assert "cd /srv/frameos/releases/release_build12345678 && sudo ./frameos setup" in deployer.commands
    assert "cd /srv/frameos/current && sudo ./frameos setup" not in deployer.commands
    assert post_deploy["final_action"] == "reboot"
    assert "sudo systemctl enable frameos.service" not in deployer.commands
    assert "sudo reboot" not in deployer.commands
    assert deployer.restarted_services == []


@pytest.mark.asyncio
async def test_run_release_setup_remounts_read_only_root_around_setup():
    frame = SimpleNamespace(
        id=10,
        name="SetupReadonlyRootFrame",
        reboot={"enabled": "false"},
        last_successful_deploy_at=None,
        last_successful_deploy={"frameos_version": "9.9.9"},
        to_dict=lambda: {"id": 10, "name": "SetupReadonlyRootFrame"},
    )
    deployer = RecordingDeployer()
    deployer.root_read_only = True
    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=deployer,
        temp_dir="",
        binary_builder=FakeBinaryBuilder(),
    )

    post_deploy = {
        "final_action": "restart_frameos",
    }

    await workflow._run_release_setup(
        build_id="build12345678",
        post_deploy=post_deploy,
    )

    assert post_deploy["final_action"] == "restart_frameos"
    root_check = next(index for index, command in enumerate(deployer.commands) if command.startswith("awk '$2 == \"/\" "))
    remount_rw = deployer.commands.index("sudo mount -o remount,rw /")
    setup = deployer.commands.index("cd /srv/frameos/releases/release_build12345678 && sudo ./frameos setup")
    sync = deployer.commands.index("sudo sync")
    remount_ro = deployer.commands.index("sudo mount -o remount,ro /")
    assert root_check < remount_rw < setup < sync < remount_ro
    assert ("stdout", "Root filesystem is read-only; remounting read-write for setup") in deployer.logs
    assert ("stdout", "Restoring root filesystem to read-only after setup") in deployer.logs


@pytest.mark.asyncio
async def test_run_release_setup_uses_systemd_run_when_deploying_through_remote():
    frame = SimpleNamespace(
        id=10,
        name="SetupRemoteFrame",
        agent={"agentEnabled": True, "agentRunCommands": True, "deployWithAgent": True},
        reboot={"enabled": "false"},
        last_successful_deploy_at=None,
        last_successful_deploy={"frameos_version": "9.9.9"},
        to_dict=lambda: {"id": 10, "name": "SetupRemoteFrame"},
    )
    deployer = RecordingDeployer()
    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=deployer,
        temp_dir="",
        binary_builder=FakeBinaryBuilder(),
    )

    await workflow._run_release_setup(
        build_id="build12345678",
        post_deploy={"final_action": "restart_frameos"},
    )

    setup_command = next(command for command in deployer.commands if "./frameos setup" in command)
    assert "sudo -n systemd-run --quiet --wait --pipe --collect" in setup_command
    assert "FRAMEOS_SETUP_UNDER_REMOTE=1" in setup_command
    assert 'FRAMEOS_SERVICE_USER="$1"' in setup_command
    assert "/srv/frameos/releases/release_build12345678" in setup_command
    assert "cd /srv/frameos/releases/release_build12345678 && sudo ./frameos setup" not in deployer.commands


@pytest.mark.asyncio
async def test_buildroot_current_setup_continues_after_legacy_systemd_service_write_failure():
    frame = SimpleNamespace(
        id=10,
        name="BuildrootSetupFrame",
        mode="buildroot",
        reboot={"enabled": "false"},
        last_successful_deploy_at=None,
        last_successful_deploy={"frameos_version": "9.9.9", "frameos_commands": list(FRAMEOS_AVAILABLE_COMMANDS)},
        to_dict=lambda: {"id": 10, "name": "BuildrootSetupFrame", "mode": "buildroot"},
    )
    deployer = RecordingDeployer()
    deployer.setup_exit_code = 1
    deployer.setup_output = [
        "FrameOS setup: starting",
        "FrameOS setup: driver setup: complete",
        "FrameOS setup: checking systemd services",
        "FrameOS setup: systemd services: installing frameos.service",
        "FrameOS setup: systemd services: failed: cannot open: /etc/systemd/system/frameos.service",
        "FrameOS fatal: cannot open: /etc/systemd/system/frameos.service",
    ]
    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=deployer,
        temp_dir="",
        binary_builder=FakeBinaryBuilder(),
    )

    setup_requires_reboot = await workflow._run_current_setup()

    assert setup_requires_reboot is False
    assert "cd /srv/frameos/current && sudo ./frameos setup" in deployer.commands
    assert any("failed refreshing the Buildroot systemd service file" in message for _kind, message in deployer.logs)
    assert not any("diagnostics:" in command for command in deployer.commands)


@pytest.mark.asyncio
async def test_buildroot_release_setup_fails_on_systemd_service_write_failure():
    frame = SimpleNamespace(
        id=10,
        name="BuildrootReleaseSetupFrame",
        mode="buildroot",
        reboot={"enabled": "false"},
        last_successful_deploy_at=None,
        last_successful_deploy={"frameos_version": "9.9.9"},
        to_dict=lambda: {"id": 10, "name": "BuildrootReleaseSetupFrame", "mode": "buildroot"},
    )
    deployer = RecordingDeployer()
    deployer.setup_exit_code = 1
    deployer.setup_output = [
        "FrameOS setup: starting",
        "FrameOS setup: driver setup: complete",
        "FrameOS setup: checking systemd services",
        "FrameOS setup: systemd services: installing frameos.service",
        "FrameOS setup: systemd services: failed: cannot open: /etc/systemd/system/frameos.service",
        "FrameOS fatal: cannot open: /etc/systemd/system/frameos.service",
    ]
    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=deployer,
        temp_dir="",
        binary_builder=FakeBinaryBuilder(),
    )

    with pytest.raises(RuntimeError, match="FrameOS setup failed with exit code 1"):
        await workflow._run_release_setup(
            build_id="build12345678",
            post_deploy={"final_action": "restart_frameos"},
        )

    assert "cd /srv/frameos/releases/release_build12345678 && sudo ./frameos setup" in deployer.commands
    assert any("FrameOS setup exited with code 1; collecting diagnostics" in message for _kind, message in deployer.logs)
    assert "free -m" in deployer.commands
    assert not any("failed refreshing the Buildroot systemd service file" in message for _kind, message in deployer.logs)


@pytest.mark.asyncio
async def test_stop_frameos_for_release_setup_leaves_remote_running():
    frame = SimpleNamespace(
        id=10,
        name="SetupStopFrame",
        reboot={"enabled": "false"},
        last_successful_deploy_at=None,
        last_successful_deploy={"frameos_version": "9.9.9"},
        to_dict=lambda: {"id": 10, "name": "SetupStopFrame"},
    )
    deployer = RecordingDeployer()
    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=deployer,
        temp_dir="",
        binary_builder=FakeBinaryBuilder(),
    )

    stopped = await workflow._stop_frameos_for_release_setup()

    assert stopped is True
    assert "sudo systemctl stop frameos.service" in deployer.commands
    assert "sudo sh -c 'killall frameos 2>/dev/null || true'" in deployer.commands
    assert all("frameos-remote" not in command and "frameos_agent" not in command for command in deployer.commands)


@pytest.mark.asyncio
async def test_stop_frameos_for_release_setup_treats_missing_service_as_not_running():
    frame = SimpleNamespace(
        id=10,
        name="SetupStopFrame",
        reboot={"enabled": "false"},
        last_successful_deploy_at=None,
        last_successful_deploy={"frameos_version": "9.9.9"},
        to_dict=lambda: {"id": 10, "name": "SetupStopFrame"},
    )

    class MissingServiceDeployer(RecordingDeployer):
        async def exec_command(self, command: str, **kwargs) -> int:
            self.commands.append(command)
            if command == "sudo systemctl stop frameos.service":
                return 5
            if command == "sudo sh -c 'killall frameos 2>/dev/null || true'":
                return 0
            return await super().exec_command(command, **kwargs)

    deployer = MissingServiceDeployer()
    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=deployer,
        temp_dir="",
        binary_builder=FakeBinaryBuilder(),
    )

    stopped = await workflow._stop_frameos_for_release_setup()

    assert stopped is False
    assert "sudo systemctl stop frameos.service" in deployer.commands
    assert "sudo sh -c 'killall frameos 2>/dev/null || true'" in deployer.commands
    assert not any(kind == "stderr" for kind, _message in deployer.logs)
    assert any("service was not loaded" in message for _kind, message in deployer.logs)


@pytest.mark.asyncio
async def test_run_post_deploy_cleanup_reboots_when_setup_requested_it():
    frame = SimpleNamespace(
        id=10,
        name="SetupRebootFrame",
        reboot={"enabled": "false"},
        last_successful_deploy_at=None,
        last_successful_deploy={"frameos_version": "9.9.9"},
        to_dict=lambda: {"id": 10, "name": "SetupRebootFrame"},
    )
    deployer = RecordingDeployer()
    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=deployer,
        temp_dir="",
        binary_builder=FakeBinaryBuilder(),
    )

    await workflow._run_post_deploy_cleanup(
        post_deploy={
            "boot_config_path": "/boot/custom.txt",
            "low_memory_masks_apt_daily": False,
            "reboot_schedule": {"needs_update": False, "needs_remove": False},
            "bootconfig_changes": [],
            "disable_userconfig": False,
            "disable_caddy_service": False,
            "final_action": "reboot",
        }
    )

    assert "sudo systemctl enable frameos.service" not in deployer.commands
    assert "sudo reboot" in deployer.commands
    assert deployer.restarted_services == []


@pytest.mark.asyncio
async def test_execute_fast_uses_atomic_uploads_before_reload(monkeypatch: pytest.MonkeyPatch):
    frame = SimpleNamespace(
        id=21,
        name="FastFrame",
        status="ready",
        https_proxy={"enable": False},
        last_successful_deploy={
            "frameos_version": "9.9.9",
            "frameos_commands": list(FRAMEOS_AVAILABLE_COMMANDS),
            "https_proxy": {"enable": False},
        },
        last_successful_deploy_at=None,
        to_dict=lambda: {"id": 21, "name": "FastFrame"},
    )
    deployer = RecordingDeployer()
    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=deployer,
        temp_dir="",
        binary_builder=FakeBinaryBuilder(),
    )

    async def fake_update_frame(_db, _redis, _frame):
        return _frame

    async def fake_fetch_frame_http_bytes(_frame, _redis, *, path: str, method: str):
        assert path == "/reload"
        assert method == "POST"
        return 200, b'{"status":"ok"}', {}

    monkeypatch.setattr("app.tasks.frame_deploy_workflow.update_frame", fake_update_frame)
    monkeypatch.setattr("app.tasks.frame_deploy_workflow._fetch_frame_http_bytes", fake_fetch_frame_http_bytes)

    plan = FrameDeployPlan(
        mode="fast",
        frame_id=21,
        frame_name="FastFrame",
        build_id="build12345678",
        frame_dict={"id": 21, "name": "FastFrame"},
        previous_frameos_version="9.9.9",
        fast_deploy=SimpleNamespace(
            tls_settings_changed=False,
            reload_supported=True,
            action="reload",
        ),
    )

    await workflow._execute_fast(plan)

    assert deployer.atomic_uploads == [
        ("/srv/frameos/current/frame.json", False),
        ("/srv/frameos/current/scenes.json.gz", True),
        ("/srv/frameos/current/all_scenes.json.gz", True),
    ]
    assert "cd /srv/frameos/current && sudo ./frameos setup" in deployer.commands


@pytest.mark.asyncio
async def test_execute_embedded_fast_uploads_scenes_then_reloads(monkeypatch: pytest.MonkeyPatch):
    frame = SimpleNamespace(
        id=53,
        name="ESPvaarikas",
        mode="embedded",
        status="ready",
        scenes=[{"id": "scene-a", "nodes": []}],
        last_log_at="2026-06-14T00:14:41+00:00",
        last_successful_deploy=None,
        last_successful_deploy_at=None,
        to_dict=lambda: {"id": 53, "name": "ESPvaarikas", "mode": "embedded"},
    )
    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=RecordingDeployer(),
        temp_dir="",
        binary_builder=FakeBinaryBuilder(),
    )
    calls: list[dict[str, object]] = []
    logs: list[tuple[str, str]] = []

    async def fake_update_frame(_db, _redis, _frame):
        return _frame

    async def fake_log(_db, _redis, _frame_id, log_type: str, message: str):
        logs.append((log_type, message))

    async def fake_fetch_frame_http_bytes(
        _frame,
        _redis,
        *,
        path: str,
        method: str,
        body=None,
        headers=None,
        timeout=None,
    ):
        calls.append({"path": path, "method": method, "body": body, "headers": headers})
        return 200, b'{"status":"ok"}', {}

    monkeypatch.setattr("app.tasks.frame_deploy_workflow.update_frame", fake_update_frame)
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.log", fake_log)
    monkeypatch.setattr("app.tasks.frame_deploy_workflow._fetch_frame_http_bytes", fake_fetch_frame_http_bytes)

    plan = FrameDeployPlan(
        mode="fast",
        frame_id=53,
        frame_name="ESPvaarikas",
        build_id="build12345678",
        frame_dict={"id": 53, "name": "ESPvaarikas", "mode": "embedded"},
        previous_frameos_version=None,
        fast_deploy=SimpleNamespace(
            tls_settings_changed=False,
            reload_supported=True,
            action="http_upload_scenes_reload",
        ),
    )

    await workflow._execute_embedded_fast(plan)

    assert calls == [
        {
            "path": "/uploadScenes",
            "method": "POST",
            "body": b'[{"id":"scene-a","nodes":[]}]',
            "headers": {"Content-Type": "application/json"},
        },
        {"path": "/reload", "method": "POST", "body": None, "headers": None},
    ]
    assert frame.status == "starting"
    assert frame.last_successful_deploy == {"id": 53, "name": "ESPvaarikas", "mode": "embedded"}
    assert frame.last_successful_deploy_at is not None
    assert any("Embedded fast deploy complete" in message for _, message in logs)


@pytest.mark.asyncio
async def test_execute_embedded_fast_failure_includes_status_context(monkeypatch: pytest.MonkeyPatch):
    frame = SimpleNamespace(
        id=59,
        name="SuurESP",
        mode="embedded",
        status="ready",
        scenes=[{"id": "scene-a", "nodes": []}],
        last_log_at="2026-06-14T00:14:41+00:00",
        last_successful_deploy=None,
        last_successful_deploy_at=None,
        to_dict=lambda: {"id": 59, "name": "SuurESP", "mode": "embedded"},
    )
    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=RecordingDeployer(),
        temp_dir="",
        binary_builder=FakeBinaryBuilder(),
    )
    calls: list[str] = []

    async def fake_update_frame(_db, _redis, _frame):
        return _frame

    async def fake_log(_db, _redis, _frame_id, log_type: str, message: str):
        return None

    async def fake_fetch_frame_http_bytes(
        _frame,
        _redis,
        *,
        path: str,
        method: str,
        body=None,
        headers=None,
        timeout=None,
    ):
        calls.append(path)
        if path == "/status":
            return 200, json.dumps({
                "version": "v2026.6.29-14-gd17bbe05",
                "storage": {"stateBytes": 25165824, "flashBytes": 33554432},
                # A PSRAM-less C3 reports exactly this shape when a render
                # fails: six figures free, no block big enough to use.
                "memory": {"internalFree": 123456, "internalLargestBlock": 15872, "psramFree": 0},
                "scenes": {"loaded": 0, "available": 0},
            }).encode("utf-8"), {}
        return 500, b"UNKNOWN ERROR", {}

    monkeypatch.setattr("app.tasks.frame_deploy_workflow.update_frame", fake_update_frame)
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.log", fake_log)
    monkeypatch.setattr("app.tasks.frame_deploy_workflow._fetch_frame_http_bytes", fake_fetch_frame_http_bytes)

    plan = FrameDeployPlan(
        mode="fast",
        frame_id=59,
        frame_name="SuurESP",
        build_id="build12345678",
        frame_dict={"id": 59, "name": "SuurESP", "mode": "embedded"},
        previous_frameos_version=None,
        fast_deploy=SimpleNamespace(
            tls_settings_changed=False,
            reload_supported=True,
            action="http_upload_scenes_reload",
        ),
    )

    with pytest.raises(RuntimeError) as exc:
        await workflow._execute_embedded_fast(plan)

    assert calls == ["/uploadScenes", "/status"]
    assert "UNKNOWN ERROR" in str(exc.value)
    assert "version=v2026.6.29-14-gd17bbe05" in str(exc.value)
    assert "stateBytes=25165824" in str(exc.value)
    assert "internalFree=123456" in str(exc.value)
    assert "internalLargestBlock=15872" in str(exc.value)
    assert "scenes.loaded=0" in str(exc.value)
    assert frame.status == "uninitialized"


@pytest.mark.asyncio
async def test_execute_fast_skips_setup_for_old_frameos_without_setup_command(monkeypatch: pytest.MonkeyPatch):
    frame = SimpleNamespace(
        id=24,
        name="OldFastFrame",
        status="ready",
        https_proxy={"enable": False},
        last_successful_deploy={"frameos_version": "2026.1.1", "https_proxy": {"enable": False}},
        last_successful_deploy_at=None,
        to_dict=lambda: {"id": 24, "name": "OldFastFrame"},
    )
    deployer = RecordingDeployer()
    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=deployer,
        temp_dir="",
        binary_builder=FakeBinaryBuilder(),
    )

    async def fake_update_frame(_db, _redis, _frame):
        return _frame

    async def fake_fetch_frame_http_bytes(_frame, _redis, *, path: str, method: str):
        assert path == "/reload"
        assert method == "POST"
        return 200, b'{"status":"ok"}', {}

    monkeypatch.setattr("app.tasks.frame_deploy_workflow.update_frame", fake_update_frame)
    monkeypatch.setattr("app.tasks.frame_deploy_workflow._fetch_frame_http_bytes", fake_fetch_frame_http_bytes)

    plan = FrameDeployPlan(
        mode="fast",
        frame_id=24,
        frame_name="OldFastFrame",
        build_id="build12345678",
        frame_dict={"id": 24, "name": "OldFastFrame"},
        previous_frameos_version="2026.1.1",
        fast_deploy=SimpleNamespace(
            tls_settings_changed=False,
            reload_supported=True,
            action="reload",
        ),
    )

    await workflow._execute_fast(plan)

    assert not any(command.endswith("&& sudo ./frameos setup") for command in deployer.commands)
    assert not any("grep -aq 'FrameOS setup: starting'" in command for command in deployer.commands)
    assert (
        "stdout",
        "🔷 Skipping FrameOS device setup; current FrameOS does not list the setup command",
    ) in deployer.logs
    assert deployer.restarted_services == []


@pytest.mark.asyncio
async def test_execute_full_marks_stuck_deploy_as_undeployed(monkeypatch: pytest.MonkeyPatch):
    frame = SimpleNamespace(
        id=22,
        name="StuckFrame",
        status="deploying",
        last_successful_deploy={"frameos_version": "9.9.9"},
        last_successful_deploy_at="2026-01-01T00:00:00+00:00",
        to_dict=lambda: {"id": 22, "name": "StuckFrame"},
    )
    deployer = RecordingDeployer()
    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=deployer,
        temp_dir="",
        binary_builder=FakeBinaryBuilder(),
    )
    updated_statuses: list[str] = []

    async def fake_update_frame(_db, _redis, updated_frame):
        updated_statuses.append(updated_frame.status)
        return updated_frame

    monkeypatch.setattr("app.tasks.frame_deploy_workflow.update_frame", fake_update_frame)

    plan = FrameDeployPlan(
        mode="full",
        frame_id=22,
        frame_name="StuckFrame",
        build_id="build12345678",
        frame_dict={"id": 22, "name": "StuckFrame"},
        previous_frameos_version="9.9.9",
        full_deploy=FullDeployPlan(
            target={},
            low_memory=False,
            drivers=[],
            binary_plan=await FakeBinaryBuilder().plan_build(),
        ),
    )

    await workflow._execute_full(plan)

    assert frame.status == "uninitialized"
    assert updated_statuses == ["uninitialized"]
    assert deployer.logs == [
        ("stderr", "Already deploying. Marked frame as undeployed; request deploy again to start fresh."),
    ]


@pytest.mark.asyncio
async def test_execute_full_does_not_activate_release_when_setup_fails(monkeypatch: pytest.MonkeyPatch):
    frame = SimpleNamespace(
        id=23,
        name="SetupFailureFrame",
        status="ready",
        ssh_user="pi",
        last_successful_deploy={"frameos_version": "9.9.9"},
        last_successful_deploy_at="2026-01-01T00:00:00+00:00",
        to_dict=lambda: {"id": 23, "name": "SetupFailureFrame"},
    )
    deployer = RecordingDeployer()
    deployer.setup_exit_code = 1
    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=deployer,
        temp_dir="",
        binary_builder=FakeBinaryBuilder(),
    )
    updated_statuses: list[str] = []

    async def fake_update_frame(_db, _redis, updated_frame):
        updated_statuses.append(updated_frame.status)
        return updated_frame

    async def fake_ensure_sudo_available(_deployer):
        return None

    async def record_command(name: str):
        deployer.commands.append(name)

    async def fake_build_full_release_binary(_full_plan):
        await record_command("build")
        return SimpleNamespace(
            cross_compiled=True,
            prebuilt_entry=None,
            build_dir="/tmp/build",
            driver_library_paths=[],
        )

    async def fake_prepare_remote_for_full_release(**_kwargs):
        await record_command("prepare_remote")
        return None

    async def fake_prepare_release_directory(_build_id):
        await record_command("prepare_release")

    async def fake_publish_release_binary(**_kwargs):
        await record_command("publish_binary")

    async def fake_upload_release_metadata(_build_id):
        await record_command("upload_metadata")

    async def fake_sync_vendor_dependencies(**_kwargs):
        await record_command("sync_vendor")

    monkeypatch.setattr("app.tasks.frame_deploy_workflow.update_frame", fake_update_frame)
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.ensure_sudo_available", fake_ensure_sudo_available)
    monkeypatch.setattr(
        workflow,
        "_install_authorized_keys_for_full_deploy",
        lambda _full_plan: record_command("ssh_keys"),
    )
    monkeypatch.setattr(workflow, "_build_full_release_binary", fake_build_full_release_binary)
    monkeypatch.setattr(workflow, "_prepare_remote_for_full_release", fake_prepare_remote_for_full_release)
    monkeypatch.setattr(workflow, "_prepare_release_directory", fake_prepare_release_directory)
    monkeypatch.setattr(workflow, "_publish_release_binary", fake_publish_release_binary)
    monkeypatch.setattr(workflow, "_upload_release_metadata", fake_upload_release_metadata)
    monkeypatch.setattr(workflow, "_sync_vendor_dependencies", fake_sync_vendor_dependencies)

    plan = FrameDeployPlan(
        mode="full",
        frame_id=23,
        frame_name="SetupFailureFrame",
        build_id="build12345678",
        frame_dict={"id": 23, "name": "SetupFailureFrame"},
        previous_frameos_version="9.9.9",
        full_deploy=FullDeployPlan(
            target={},
            low_memory=False,
            drivers=[],
            binary_plan=await FakeBinaryBuilder().plan_build(),
            post_deploy={"final_action": "restart_frameos"},
        ),
    )

    with pytest.raises(RuntimeError, match="FrameOS setup failed with exit code 1"):
        await workflow._execute_full(plan)

    assert "cd /srv/frameos/releases/release_build12345678 && sudo ./frameos setup" in deployer.commands
    assert deployer.commands.index("sudo systemctl stop frameos.service") < deployer.commands.index(
        "cd /srv/frameos/releases/release_build12345678 && sudo ./frameos setup"
    )
    assert deployer.restarted_services == ["frameos"]
    assert frame.status == "uninitialized"
    assert updated_statuses == ["deploying", "uninitialized"]


@pytest.mark.asyncio
async def test_full_deploy_continues_when_legacy_shared_driver_setup_segfaults_after_completion(
    monkeypatch: pytest.MonkeyPatch,
):
    frame = SimpleNamespace(
        id=24,
        name="LegacyPrecompiled",
        status="ready",
        ssh_keys=[],
        rpios=None,
        reboot=None,
        last_successful_deploy={},
        to_dict=lambda: {"id": 24, "name": "LegacyPrecompiled"},
    )
    deployer = RecordingDeployer()
    deployer.setup_exit_code = 139
    deployer.setup_output = [
        "FrameOS setup: starting",
        "FrameOS setup: checking bootConfig",
        "FrameOS setup: bootConfig: complete",
        "FrameOS setup: shared driver inkyPython: setup complete",
    ]
    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=deployer,
        temp_dir="",
        binary_builder=FakeBinaryBuilder(),
    )
    updated_statuses: list[str] = []

    async def fake_update_frame(_db, _redis, updated_frame):
        updated_statuses.append(updated_frame.status)

    async def record_command(command: str):
        deployer.commands.append(command)

    monkeypatch.setattr("app.tasks.frame_deploy_workflow.update_frame", fake_update_frame)
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.ensure_sudo_available", lambda _deployer: record_command("sudo"))
    monkeypatch.setattr(workflow, "_install_authorized_keys_for_full_deploy", lambda _full_plan: record_command("ssh_keys"))
    monkeypatch.setattr(workflow, "_build_full_release_binary", lambda _full_plan: record_command("build"))
    monkeypatch.setattr(workflow, "_prepare_remote_for_full_release", lambda **_kwargs: record_command("prepare_remote"))
    monkeypatch.setattr(workflow, "_prepare_release_directory", lambda _build_id: record_command("prepare_release"))
    monkeypatch.setattr(workflow, "_publish_release_binary", lambda **_kwargs: record_command("publish_binary"))
    monkeypatch.setattr(workflow, "_upload_release_metadata", lambda _build_id: record_command("upload_metadata"))
    monkeypatch.setattr(workflow, "_sync_vendor_dependencies", lambda **_kwargs: record_command("sync_vendor"))
    monkeypatch.setattr(workflow, "_cleanup_release_artifacts", lambda: record_command("cleanup"))
    monkeypatch.setattr(workflow, "_run_post_deploy_cleanup", lambda **_kwargs: record_command("post_cleanup"))
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.sync_assets", lambda _db, _redis, _frame: record_command("assets"))
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.current_frameos_version", lambda: "2026.test")

    plan = FrameDeployPlan(
        mode="full",
        frame_id=24,
        frame_name="LegacyPrecompiled",
        build_id="build12345678",
        frame_dict={"id": 24, "name": "LegacyPrecompiled"},
        previous_frameos_version="9.9.9",
        full_deploy=FullDeployPlan(
            target={},
            low_memory=False,
            drivers=[],
            binary_plan=await FakeBinaryBuilder().plan_build(),
            post_deploy={"final_action": "restart_frameos"},
        ),
    )

    await workflow._execute_full(plan)

    assert "assets" in deployer.commands
    assert ("stderr", "FrameOS setup completed, then exited during legacy shared-driver teardown; continuing deploy.") in deployer.logs
    assert frame.status == "starting"
    assert updated_statuses == ["deploying", "starting"]


def test_legacy_shared_driver_setup_segfault_guard_requires_successful_setup_output():
    assert FrameDeployWorkflow._setup_completed_before_legacy_shared_driver_segfault(
        139,
        [
            "FrameOS setup: shared driver inkyPython: running setup",
            "FrameOS setup: inkyPython: failed: nope",
        ],
    ) is False
    assert FrameDeployWorkflow._setup_completed_before_legacy_shared_driver_segfault(
        1,
        ["FrameOS setup: shared driver inkyPython: setup complete"],
    ) is False


@pytest.mark.asyncio
async def test_setup_json_reset_cleanup_skips_when_helper_absent():
    frame = SimpleNamespace(id=24, name="NoFirstbootHelper", mode="rpios")
    deployer = RecordingDeployer()
    deployer.db = None
    deployer.redis = None
    deployer.frame = frame
    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=deployer,
        temp_dir="",
        binary_builder=FakeBinaryBuilder(),
    )

    await workflow._remove_setup_json_reset_helper()

    assert not any("Removing setup JSON reset helper" in message for _level, message in deployer.logs)
    assert not any("systemctl disable frameos-firstboot-setup.service" in command for command in deployer.commands)


@pytest.mark.asyncio
async def test_remote_build_uses_x86_feature_flags(monkeypatch: pytest.MonkeyPatch, tmp_path):
    archive_path = tmp_path / "build_build12345678.tar.gz"
    archive_path.write_bytes(b"archive")
    frame = SimpleNamespace(id=24, name="RemoteBuildFlags")
    deployer = RecordingDeployer()
    deployer.db = None
    deployer.redis = None
    deployer.frame = frame
    workflow = FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=deployer,
        temp_dir="",
        binary_builder=FakeBinaryBuilder(),
    )
    uploaded: list[str] = []

    async def fake_upload_file(_db, _redis, _frame, remote_path, _data):
        uploaded.append(remote_path)

    monkeypatch.setattr("app.tasks.frame_deploy_workflow.upload_file", fake_upload_file)

    await workflow._publish_remote_built_binary(
        SimpleNamespace(
            archive_path=str(archive_path),
            build_dir=str(tmp_path / "build_build12345678"),
            driver_library_paths=[],
            target=TargetMetadata(arch="x86_64", distro="debian", version="bookworm"),
        ),
        "build12345678",
        "/srv/frameos/releases/release_build12345678/frameos",
        "quickjs-2026-06-04",
    )

    assert uploaded == ["/srv/frameos/build/build_build12345678.tar.gz"]
    make_command = next(command for command in deployer.commands if "make -j$PARALLEL" in command)
    assert "EXTRA_CFLAGS='-mavx2 -mavx -msse4.1 -mssse3 -mpclmul -mvpclmulqdq' make -j$PARALLEL" in make_command


def _embedded_workflow_frame(**overrides) -> SimpleNamespace:
    defaults = dict(
        id=53,
        name="ESPvaarikas",
        mode="embedded",
        status="ready",
        device="waveshare.EPD_7in5_V2",
        embedded={"platform": "esp32-s3", "flashSize": "8MB"},
        device_config={},
        scenes=[{"id": "scene-a", "nodes": []}],
        last_log_at="2026-06-14T00:14:41+00:00",
        last_successful_deploy=None,
        last_successful_deploy_at=None,
        to_dict=lambda: {"id": 53, "name": "ESPvaarikas", "mode": "embedded"},
    )
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def _embedded_workflow(frame: SimpleNamespace) -> FrameDeployWorkflow:
    class NoProbeDeployer(FakeDeployer):
        async def get_distro(self) -> str:
            raise AssertionError("embedded plans should not probe Linux distro")

    return FrameDeployWorkflow(
        db=None,
        redis=None,
        frame=frame,
        deployer=NoProbeDeployer(),
        temp_dir="",
        binary_builder=FakeBinaryBuilder(),
    )


@pytest.mark.asyncio
async def test_plan_full_for_embedded_returns_ota_plan():
    frame = _embedded_workflow_frame()
    workflow = _embedded_workflow(frame)

    plan = await workflow.plan("full")

    assert plan.mode == "full"
    assert isinstance(plan.full_deploy, EmbeddedFullDeployPlan)
    assert plan.full_deploy.platform == "esp32-s3"
    assert plan.full_deploy.needs_firmware_build is True
    assert plan.frame_dict["mode"] == "embedded"
    assert plan.frame_dict["frameos_version"]

    # The drawer consumes the FullDeployPlanResponse key shape.
    payload = plan.full_deploy.to_dict()
    assert payload["target"] == {
        "arch": "esp32-s3",
        "distro": "esp-idf",
        "version": "esp32s3",
        "total_memory_mb": 8,
    }
    assert payload["packages"] == []
    assert payload["binary"]["will_attempt_precompiled"] is False
    assert payload["embedded"]["action"] == "build_firmware_ota_upload_scenes"
    assert payload["embedded"]["otaSupported"] is True


@pytest.mark.asyncio
async def test_plan_full_for_embedded_rejects_pico_and_no_ota_profiles():
    pico_frame = _embedded_workflow_frame(embedded={"platform": "pico-w", "flashSize": "2MB"})
    with pytest.raises(ValueError, match="Pico-family"):
        await _embedded_workflow(pico_frame).plan("full")

    no_ota_frame = _embedded_workflow_frame(embedded={"platform": "esp32-c3", "flashSize": "4MB"})
    with pytest.raises(ValueError, match="Flash the firmware over USB"):
        await _embedded_workflow(no_ota_frame).plan("full")

    virtual_frame = _embedded_workflow_frame(embedded={"platform": "virtual"})
    with pytest.raises(ValueError, match="Virtual frames"):
        await _embedded_workflow(virtual_frame).plan("full")


@pytest.mark.asyncio
async def test_plan_combined_for_embedded_includes_fast_and_full():
    frame = _embedded_workflow_frame()
    plan = await _embedded_workflow(frame).plan("combined")

    assert plan.mode == "combined"
    assert plan.fast_deploy is not None
    assert plan.fast_deploy.action == "http_upload_scenes_reload"
    assert isinstance(plan.full_deploy, EmbeddedFullDeployPlan)
    assert any("over the air" in note for note in plan.notes)


@pytest.mark.asyncio
async def test_plan_combined_for_embedded_pico_keeps_fast_only():
    frame = _embedded_workflow_frame(embedded={"platform": "pico-2w", "flashSize": "4MB"})
    plan = await _embedded_workflow(frame).plan("combined")

    assert plan.fast_deploy is not None
    assert plan.full_deploy is None
    assert any(note.startswith("Full deploy unavailable:") for note in plan.notes)


def _embedded_full_plan_for(frame: SimpleNamespace) -> FrameDeployPlan:
    return FrameDeployPlan(
        mode="full",
        frame_id=int(frame.id),
        frame_name=frame.name,
        build_id="build12345678",
        frame_dict={"id": int(frame.id), "name": frame.name, "mode": "embedded"},
        previous_frameos_version=None,
        full_deploy=EmbeddedFullDeployPlan(
            platform="esp32-s3",
            idf_target="esp32s3",
            flash_size="8MB",
            psram_mb=8,
            ota_supported=True,
            firmware_status="stale",
            firmware_error=None,
            needs_firmware_build=True,
        ),
    )


@pytest.mark.asyncio
async def test_execute_embedded_full_builds_ota_waits_for_boot_and_uploads_scenes(
    monkeypatch: pytest.MonkeyPatch,
):
    from datetime import datetime, timedelta, timezone

    frame = _embedded_workflow_frame()
    workflow = _embedded_workflow(frame)
    workflow.EMBEDDED_POLL_INTERVAL_SECONDS = 0.001
    events: list[str] = []
    http_calls: list[str] = []
    firmware_statuses = [
        {"status": "stale"},
        {"status": "building"},
        {"status": "ready", "completedAt": datetime.now(timezone.utc).isoformat()},
    ]

    async def fake_update_frame(_db, _redis, _frame):
        return _frame

    async def fake_log(_db, _redis, _frame_id, _type, message):
        events.append(message)

    async def fake_refresh(_db, _redis, _frame):
        return firmware_statuses.pop(0) if len(firmware_statuses) > 1 else firmware_statuses[0]

    async def fake_start(_db, _redis, _frame, **_kwargs):
        events.append("build-started")
        return True, {"status": "queued"}

    async def fake_request_ota(_db, _redis, _frame, *_args, **_kwargs):
        events.append("ota-requested")
        # The device pulls the image and reboots; its bootup log lands in
        # frame.embedded.lastBoot.
        _frame.embedded = {
            **_frame.embedded,
            "lastBoot": {"at": (datetime.now(timezone.utc) + timedelta(seconds=1)).isoformat()},
        }
        return {"ok": True}

    async def fake_fetch_frame_http_bytes(_frame, _redis, *, path, method, body=None, headers=None, timeout=None):
        http_calls.append(path)
        return 200, b"{}", {}

    monkeypatch.setattr("app.tasks.frame_deploy_workflow.update_frame", fake_update_frame)
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.log", fake_log)
    monkeypatch.setattr("app.tasks.frame_deploy_workflow._fetch_frame_http_bytes", fake_fetch_frame_http_bytes)
    monkeypatch.setattr("app.tasks.embedded_firmware.refresh_embedded_firmware_status", fake_refresh)
    monkeypatch.setattr("app.tasks.embedded_firmware.start_embedded_firmware", fake_start)
    monkeypatch.setattr("app.tasks.embedded_firmware.request_embedded_firmware_ota", fake_request_ota)

    await workflow._execute_embedded_full(_embedded_full_plan_for(frame))

    assert "build-started" in events
    assert "ota-requested" in events
    assert http_calls == ["/uploadScenes", "/reload"]
    assert frame.status == "starting"
    assert frame.last_successful_deploy == {"id": 53, "name": "ESPvaarikas", "mode": "embedded"}
    assert frame.last_successful_deploy_at is not None
    assert any("Embedded full deploy complete" in message for message in events)


@pytest.mark.asyncio
async def test_execute_embedded_full_ota_timeout_says_it_may_still_complete(
    monkeypatch: pytest.MonkeyPatch,
):
    from datetime import datetime, timezone

    frame = _embedded_workflow_frame(
        # Last device activity predates the ready build: a reboot is required.
        last_log_at=datetime(2026, 6, 14, tzinfo=timezone.utc),
    )
    workflow = _embedded_workflow(frame)
    workflow.EMBEDDED_POLL_INTERVAL_SECONDS = 0.001
    workflow.EMBEDDED_OTA_BOOT_TIMEOUT_SECONDS = 0.01

    async def fake_update_frame(_db, _redis, _frame):
        return _frame

    async def fake_log(_db, _redis, _frame_id, _type, _message):
        return None

    async def fake_refresh(_db, _redis, _frame):
        return {"status": "ready", "completedAt": datetime.now(timezone.utc).isoformat()}

    async def fake_request_ota(_db, _redis, _frame, *_args, **_kwargs):
        return {"ok": True}

    monkeypatch.setattr("app.tasks.frame_deploy_workflow.update_frame", fake_update_frame)
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.log", fake_log)
    monkeypatch.setattr("app.tasks.embedded_firmware.refresh_embedded_firmware_status", fake_refresh)
    monkeypatch.setattr("app.tasks.embedded_firmware.request_embedded_firmware_ota", fake_request_ota)

    with pytest.raises(RuntimeError) as exc:
        await workflow._execute_embedded_full(_embedded_full_plan_for(frame))

    assert "may still" in str(exc.value)
    assert frame.status == "uninitialized"


@pytest.mark.asyncio
async def test_execute_embedded_full_skips_boot_wait_when_device_runs_current_firmware(
    monkeypatch: pytest.MonkeyPatch,
):
    from datetime import datetime, timedelta, timezone

    built_at = datetime(2026, 6, 14, tzinfo=timezone.utc)
    frame = _embedded_workflow_frame(
        embedded={
            "platform": "esp32-s3",
            "flashSize": "8MB",
            # Device booted after the ready image finished building.
            "lastBoot": {"at": (built_at + timedelta(minutes=5)).isoformat()},
        },
    )
    workflow = _embedded_workflow(frame)
    workflow.EMBEDDED_POLL_INTERVAL_SECONDS = 0.001
    workflow.EMBEDDED_OTA_BOOT_TIMEOUT_SECONDS = 0.01
    http_calls: list[str] = []

    async def fake_update_frame(_db, _redis, _frame):
        return _frame

    async def fake_log(_db, _redis, _frame_id, _type, _message):
        return None

    async def fake_refresh(_db, _redis, _frame):
        return {"status": "ready", "completedAt": built_at.isoformat()}

    async def fake_start(_db, _redis, _frame, **_kwargs):
        raise AssertionError("ready firmware must not be rebuilt")

    async def fake_request_ota(_db, _redis, _frame, *_args, **_kwargs):
        return {"ok": True}

    async def fake_fetch_frame_http_bytes(_frame, _redis, *, path, method, body=None, headers=None, timeout=None):
        http_calls.append(path)
        return 200, b"{}", {}

    monkeypatch.setattr("app.tasks.frame_deploy_workflow.update_frame", fake_update_frame)
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.log", fake_log)
    monkeypatch.setattr("app.tasks.frame_deploy_workflow._fetch_frame_http_bytes", fake_fetch_frame_http_bytes)
    monkeypatch.setattr("app.tasks.embedded_firmware.refresh_embedded_firmware_status", fake_refresh)
    monkeypatch.setattr("app.tasks.embedded_firmware.start_embedded_firmware", fake_start)
    monkeypatch.setattr("app.tasks.embedded_firmware.request_embedded_firmware_ota", fake_request_ota)

    await workflow._execute_embedded_full(_embedded_full_plan_for(frame))

    assert http_calls == ["/uploadScenes", "/reload"]
    assert frame.status == "starting"


@pytest.mark.asyncio
async def test_execute_embedded_full_surfaces_build_failure(monkeypatch: pytest.MonkeyPatch):
    frame = _embedded_workflow_frame()
    workflow = _embedded_workflow(frame)
    workflow.EMBEDDED_POLL_INTERVAL_SECONDS = 0.001
    firmware_statuses = [
        {"status": "missing"},
        {"status": "error", "error": "idf.py build failed with exit code 2:\nninja: error"},
    ]

    async def fake_update_frame(_db, _redis, _frame):
        return _frame

    async def fake_log(_db, _redis, _frame_id, _type, _message):
        return None

    async def fake_refresh(_db, _redis, _frame):
        return firmware_statuses.pop(0) if len(firmware_statuses) > 1 else firmware_statuses[0]

    async def fake_start(_db, _redis, _frame, **_kwargs):
        return True, {"status": "queued"}

    monkeypatch.setattr("app.tasks.frame_deploy_workflow.update_frame", fake_update_frame)
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.log", fake_log)
    monkeypatch.setattr("app.tasks.embedded_firmware.refresh_embedded_firmware_status", fake_refresh)
    monkeypatch.setattr("app.tasks.embedded_firmware.start_embedded_firmware", fake_start)

    with pytest.raises(RuntimeError) as exc:
        await workflow._execute_embedded_full(_embedded_full_plan_for(frame))

    assert "ninja: error" in str(exc.value)
    assert frame.status == "uninitialized"
