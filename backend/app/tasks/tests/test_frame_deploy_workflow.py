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
