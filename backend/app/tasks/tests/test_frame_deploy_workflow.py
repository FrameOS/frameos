from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.tasks.binary_builder import FrameBinaryPlan
from app.tasks.frame_deploy_workflow import FrameDeployWorkflow, FullDeployPlan, HelperActionPlan, PackagePlan
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

    def get_apt_packages(self) -> list[str]:
        return ["custom-app-pkg"]


class RecordingDeployer(FakeDeployer):
    def __init__(self):
        super().__init__()
        self.commands: list[str] = []
        self.restarted_services: list[str] = []
        self.logs: list[tuple[str, str]] = []

    async def exec_command(self, command: str, **_kwargs) -> int:
        self.commands.append(command)
        if command.startswith('grep -q "^dtoverlay=vc4-kms-v3d" '):
            return 1
        return 0

    async def restart_service(self, service: str) -> None:
        self.restarted_services.append(service)

    async def log(self, log_type: str, message: str) -> None:
        self.logs.append((log_type, message))


class FakeBinaryBuilder:
    async def plan_build(self, **_kwargs) -> FrameBinaryPlan:
        return FrameBinaryPlan(
            build_id="build12345678",
            target=TargetMetadata(arch="arm64", distro="raspios", version="bookworm"),
            allow_cross_compile=True,
            force_cross_compile=False,
            cross_compile_supported=True,
            build_host_configured=False,
            will_attempt_cross_compile=True,
            prebuilt_entry=None,
            prebuilt_target="debian-bookworm-arm64",
        )


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
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.get_settings_dict", lambda _db: {})
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
        existing_paths={"/srv/frameos/vendor/quickjs/quickjs-2025-04-26"},
    )
    deployer.success_commands.update(
        {
            "systemctl is-enabled caddy.service >/dev/null 2>&1 || systemctl is-active caddy.service >/dev/null 2>&1",
        }
    )

    monkeypatch.setattr("app.tasks.frame_deploy_workflow.drivers_for_frame", lambda _frame: {"inkyPython": SimpleNamespace(vendor_folder="inky")})
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.get_settings_dict", lambda _db: {})
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
    assert package_map["custom-app-pkg"].installed is False
    assert package_map["python3-pip"].installed is True
    assert plan.full_deploy.package_alternatives[0].installed_package == "ntp"
    assert plan.full_deploy.dependency_helper_plans == []
    assert [vendor.key for vendor in plan.full_deploy.vendor_sync_plans] == ["inkyPython"]
    assert plan.full_deploy.ssh_keys_need_install is False
    assert plan.full_deploy.post_deploy["i2c"]["needs_boot_config_line"] is False
    assert plan.full_deploy.post_deploy["i2c"]["needs_runtime_enable"] is False
    assert plan.full_deploy.post_deploy["spi_action"] == "unchanged"
    assert plan.full_deploy.post_deploy["disable_caddy_service"] is True
    assert plan.full_deploy.post_deploy["bootconfig_changes"] == []
    assert plan.full_deploy.post_deploy["final_action"] == "restart_frameos"


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
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.get_settings_dict", lambda _db: {})
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
    monkeypatch.setattr("app.tasks.frame_deploy_workflow.get_settings_dict", lambda _db: {})
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

    assert any("/boot/custom.txt" in command for command in deployer.commands)
    assert "sudo raspi-config nonint do_spi 1" in deployer.commands
    assert any("/etc/cron.d/frameos-reboot" in command for command in deployer.commands)
    assert "sudo systemctl daemon-reload" in deployer.commands
    assert deployer.restarted_services == ["frameos"]
    assert all("userconfig" not in command for command in deployer.commands)
    assert "sudo reboot" not in deployer.commands
