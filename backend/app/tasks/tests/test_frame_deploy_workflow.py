from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.tasks.binary_builder import FrameBinaryPlan
from app.tasks.frame_deploy_workflow import FrameDeployWorkflow
from app.utils.cross_compile import TargetMetadata


class FakeDeployer:
    def __init__(self, installed_packages: set[str] | None = None, existing_paths: set[str] | None = None):
        self.build_id = "build12345678"
        self.installed_packages = installed_packages or set()
        self.existing_paths = existing_paths or set()

    async def get_distro(self) -> str:
        return "raspios"

    async def get_cpu_architecture(self) -> str:
        return "arm64"

    async def get_distro_version(self) -> str:
        return "bookworm"

    async def get_total_memory_mb(self) -> int:
        return 1024

    async def exec_command(self, command: str, **_kwargs) -> int:
        if command.startswith('dpkg -l | grep -q "^ii  '):
            package_name = command.split("^ii  ", 1)[1].split(" ", 1)[0].strip('"')
            return 0 if package_name in self.installed_packages else 1
        if command.startswith("test -f "):
            path = command.removeprefix("test -f ").strip("'")
            return 0 if path in self.existing_paths else 1
        if command.startswith("test -e "):
            path = command.removeprefix("test -e ").strip("'")
            return 0 if path in self.existing_paths else 1
        raise AssertionError(f"Unexpected command: {command}")

    def get_apt_packages(self) -> list[str]:
        return ["custom-app-pkg"]


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
async def test_full_plan_reports_installed_state_and_remote_build_dependencies(monkeypatch: pytest.MonkeyPatch):
    frame = SimpleNamespace(
        id=7,
        name="Office",
        rpios={"crossCompilation": "auto"},
        reboot=None,
        last_successful_deploy={"frameos_version": "9.9.9"},
        last_successful_deploy_at="2026-01-01T00:00:00+00:00",
        to_dict=lambda: {"id": 7, "name": "Office"},
    )
    deployer = FakeDeployer(
        installed_packages={"build-essential", "ntp", "python3-pip"},
        existing_paths={"/srv/frameos/vendor/quickjs/quickjs-2025-04-26"},
    )

    monkeypatch.setattr("app.tasks.frame_deploy_workflow.drivers_for_frame", lambda _frame: {"inkyPython": SimpleNamespace(vendor_folder="inky")})
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
    assert plan.full_deploy.binary_plan.will_attempt_cross_compile is True
    assert plan.full_deploy.quickjs_installed is True
    package_map = {pkg.name: pkg for pkg in plan.full_deploy.package_plans}
    assert package_map["build-essential"].installed is True
    assert package_map["caddy"].installed is False
    assert package_map["custom-app-pkg"].installed is False
    assert package_map["python3-pip"].installed is True
    assert plan.full_deploy.package_alternatives[0].installed_package == "ntp"
    assert plan.full_deploy.post_deploy["spi_action"] == "unchanged"
    assert plan.full_deploy.post_deploy["disable_caddy_service"] is True
    assert plan.full_deploy.post_deploy["final_action"] == "restart_frameos"


@pytest.mark.asyncio
async def test_full_plan_includes_post_deploy_driver_and_reboot_steps(monkeypatch: pytest.MonkeyPatch):
    frame = SimpleNamespace(
        id=8,
        name="DriverFrame",
        rpios={"crossCompilation": "auto"},
        reboot={"enabled": "true", "crontab": "5 4 * * *", "type": "raspberry"},
        last_successful_deploy_at=None,
        last_successful_deploy={"frameos_version": "9.9.9"},
        to_dict=lambda: {"id": 8, "name": "DriverFrame"},
    )
    deployer = FakeDeployer(existing_paths={"/boot/firmware/config.txt"})

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

    plan = await workflow.plan("full")

    assert plan.full_deploy is not None
    post_deploy = plan.full_deploy.post_deploy
    assert post_deploy["boot_config_path"] == "/boot/firmware/config.txt"
    assert post_deploy["enable_i2c"] is True
    assert post_deploy["spi_action"] == "enable"
    assert post_deploy["low_memory_masks_apt_daily"] is True
    assert post_deploy["reboot_schedule"] == {
        "enabled": True,
        "crontab": "5 4 * * *",
        "type": "raspberry",
        "command": "/sbin/shutdown -r now",
    }
    assert post_deploy["bootconfig_lines"] == ["dtoverlay=vc4-kms-v3d", "#dtoverlay=old-setting"]
    assert post_deploy["disable_userconfig"] is True
    assert post_deploy["disable_caddy_service"] is True
    assert post_deploy["final_action"] == "reboot"
