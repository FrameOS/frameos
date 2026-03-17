import json
from pathlib import Path

import pytest

from app.utils import prebuilt_cross_release
from app.utils.prebuilt_cross_release import ReleaseBuildPlan, resolve_release_build_plan


def test_resolve_release_build_plan_defaults_to_one_target_at_a_time_and_max_driver_jobs():
    plan = resolve_release_build_plan(
        frameos_version="2026.3.3+abc123",
        requested_targets=(),
        available_target_slugs=(
            "debian-bookworm-arm64",
            "debian-bookworm-amd64",
            "ubuntu-24.04-amd64",
        ),
        jobs=8,
    )

    assert plan.frameos_version == "2026.3.3+abc123"
    assert plan.frameos_release_version == "2026.3.3"
    assert plan.targets == (
        "debian-bookworm-arm64",
        "debian-bookworm-amd64",
        "ubuntu-24.04-amd64",
    )
    assert plan.target_jobs == 1
    assert plan.driver_jobs == 8


def test_resolve_release_build_plan_deduplicates_requested_targets_and_respects_overrides():
    plan = resolve_release_build_plan(
        frameos_version="2026.3.3",
        requested_targets=(
            "ubuntu-24.04-amd64",
            "ubuntu-24.04-amd64",
            "debian-bookworm-arm64",
        ),
        available_target_slugs=(
            "debian-bookworm-arm64",
            "ubuntu-24.04-amd64",
        ),
        jobs=16,
        target_jobs=2,
        driver_jobs=6,
    )

    assert plan.targets == ("ubuntu-24.04-amd64", "debian-bookworm-arm64")
    assert plan.target_jobs == 2
    assert plan.driver_jobs == 6


def test_resolve_release_build_plan_rejects_unknown_targets():
    try:
        resolve_release_build_plan(
            frameos_version="2026.3.3",
            requested_targets=("not-a-target",),
            available_target_slugs=("debian-bookworm-arm64",),
        )
    except ValueError as exc:
        assert "Unknown target(s): not-a-target" in str(exc)
    else:
        raise AssertionError("Expected unknown target validation to fail")


def test_parse_args_accepts_repeatable_target_flag():
    args = prebuilt_cross_release.parse_args(
        ["2026.3.3", "--target", "debian-bookworm-arm64", "--target", "ubuntu-24.04-amd64"]
    )

    assert args.frameos_version == "2026.3.3"
    assert args.targets == []
    assert args.target == ["debian-bookworm-arm64", "ubuntu-24.04-amd64"]


def test_target_build_commands_only_build_frameos_and_drivers(tmp_path: Path):
    plan = ReleaseBuildPlan(
        frameos_version="2026.3.3+abc123",
        frameos_release_version="2026.3.3",
        targets=("debian-bookworm-arm64",),
        jobs=8,
        target_jobs=1,
        driver_jobs=3,
    )
    cross_script = tmp_path / "backend" / "bin" / "cross"
    release_dir = tmp_path / "build" / "frameos"

    frameos_command, drivers_command = prebuilt_cross_release._target_build_commands(
        target="debian-bookworm-arm64",
        plan=plan,
        repo_root=tmp_path,
        release_dir=release_dir,
        cross_script=cross_script,
        python_executable="python3",
    )

    assert frameos_command == (
        "python3",
        str(cross_script),
        "build-frameos",
        "--target",
        "debian-bookworm-arm64",
        "--frameos-root",
        str(tmp_path / "frameos"),
        "--artifacts-dir",
        str(release_dir),
        "--release-version",
        "2026.3.3",
    )
    assert drivers_command == (
        "python3",
        str(cross_script),
        "build-drivers",
        "--target",
        "debian-bookworm-arm64",
        "--frameos-root",
        str(tmp_path / "frameos"),
        "--artifacts-dir",
        str(release_dir),
        "--release-version",
        "2026.3.3",
        "--jobs",
        "3",
    )


@pytest.mark.asyncio
async def test_run_target_build_writes_target_manifest_without_touching_prebuilt_deps(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    plan = ReleaseBuildPlan(
        frameos_version="2026.3.3+abc123",
        frameos_release_version="2026.3.3",
        targets=("debian-bookworm-arm64",),
        jobs=8,
        target_jobs=1,
        driver_jobs=3,
    )
    repo_root = tmp_path
    release_dir = repo_root / "build" / "frameos"
    target_dir = release_dir / "debian-bookworm-arm64"
    target_dir.mkdir(parents=True, exist_ok=True)
    cross_script = repo_root / "backend" / "bin" / "cross"
    calls: list[tuple[str, ...]] = []

    async def fake_run_prefixed_command(*, prefix: str, argv: tuple[str, ...], cwd: Path, env: dict[str, str]) -> None:
        assert prefix == "debian-bookworm-arm64"
        assert cwd == repo_root
        assert env["PYTHONUNBUFFERED"] == "1"
        calls.append(tuple(argv))
        if "build-frameos" in argv:
            runtime_dir = target_dir / "runtime"
            runtime_dir.mkdir(parents=True, exist_ok=True)
            (runtime_dir / "frameos.2026.3.3").write_bytes(b"frameos")
            (target_dir / "metadata.json").write_text("{}", encoding="utf-8")
            return
        driver_dir = target_dir / "drivers" / "driver"
        driver_dir.mkdir(parents=True, exist_ok=True)
        (driver_dir / "driver.2026.3.3.so").write_bytes(b"driver")

    monkeypatch.setattr(prebuilt_cross_release, "_run_prefixed_command", fake_run_prefixed_command)

    metrics = await prebuilt_cross_release._run_target_build(
        target="debian-bookworm-arm64",
        plan=plan,
        repo_root=repo_root,
        release_dir=release_dir,
        cross_script=cross_script,
        python_executable="python3",
    )

    manifest = json.loads((target_dir / "manifest.2026.3.3.json").read_text(encoding="utf-8"))
    assert calls == [
        (
            "python3",
            str(cross_script),
            "build-frameos",
            "--target",
            "debian-bookworm-arm64",
            "--frameos-root",
            str(repo_root / "frameos"),
            "--artifacts-dir",
            str(release_dir),
            "--release-version",
            "2026.3.3",
        ),
        (
            "python3",
            str(cross_script),
            "build-drivers",
            "--target",
            "debian-bookworm-arm64",
            "--frameos-root",
            str(repo_root / "frameos"),
            "--artifacts-dir",
            str(release_dir),
            "--release-version",
            "2026.3.3",
            "--jobs",
            "3",
        ),
    ]
    assert manifest["frameos_version"] == "2026.3.3"
    assert manifest["source_version"] == "2026.3.3+abc123"
    assert manifest["target"] == "debian-bookworm-arm64"
    assert {artifact["path"] for artifact in manifest["artifacts"]} == {
        "drivers/driver/driver.2026.3.3.so",
        "runtime/frameos.2026.3.3",
        "metadata.json",
    }
    assert metrics.target == "debian-bookworm-arm64"
    assert metrics.frameos_size_bytes == len(b"frameos")
    assert metrics.drivers_size_bytes == len(b"driver")
    assert metrics.driver_count == 1
    assert metrics.artifact_count == 4
    assert metrics.total_size_bytes == len(b"frameos") + len(b"driver") + len("{}") + len((target_dir / "manifest.2026.3.3.json").read_bytes())


@pytest.mark.asyncio
async def test_run_release_build_writes_metrics_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    plan = ReleaseBuildPlan(
        frameos_version="2026.3.3+abc123",
        frameos_release_version="2026.3.3",
        targets=("debian-bookworm-arm64", "ubuntu-24.04-amd64"),
        jobs=8,
        target_jobs=1,
        driver_jobs=8,
    )
    repo_root = tmp_path
    cross_script = repo_root / "backend" / "bin" / "cross"
    cross_script.parent.mkdir(parents=True, exist_ok=True)
    cross_script.write_text("#!/usr/bin/env python3\n", encoding="utf-8")
    release_dir = repo_root / "build" / "frameos"

    async def fake_run_target_build(
        *,
        target: str,
        plan: ReleaseBuildPlan,
        repo_root: Path,
        release_dir: Path,
        cross_script: Path,
        python_executable: str = "python3",
    ) -> prebuilt_cross_release.TargetBuildMetrics:
        target_dir = release_dir / target
        target_dir.mkdir(parents=True, exist_ok=True)
        (target_dir / "runtime").mkdir(parents=True, exist_ok=True)
        (target_dir / "runtime" / f"frameos.{plan.frameos_release_version}").write_bytes(target.encode("utf-8"))
        (target_dir / "drivers" / "driver").mkdir(parents=True, exist_ok=True)
        (target_dir / "drivers" / "driver" / f"driver.{plan.frameos_release_version}.so").write_bytes(b"driver")
        (target_dir / "metadata.json").write_text("{}", encoding="utf-8")
        (target_dir / f"manifest.{plan.frameos_release_version}.json").write_text("{}", encoding="utf-8")
        return prebuilt_cross_release.TargetBuildMetrics(
            target=target,
            duration_seconds=1.25,
            total_size_bytes=123,
            frameos_size_bytes=45,
            drivers_size_bytes=67,
            driver_count=1,
            artifact_count=4,
        )

    monkeypatch.setattr(prebuilt_cross_release, "_run_target_build", fake_run_target_build)

    result = await prebuilt_cross_release.run_release_build(
        plan,
        repo_root=repo_root,
        cross_script=cross_script,
    )

    payload = json.loads(result.metrics_path.read_text(encoding="utf-8"))
    assert result.release_dir == release_dir
    assert payload["frameos_version"] == "2026.3.3"
    assert payload["source_version"] == "2026.3.3+abc123"
    assert payload["target_count"] == 2
    assert payload["target_jobs"] == 1
    assert payload["driver_jobs"] == 8
    assert [entry["target"] for entry in payload["targets"]] == [
        "debian-bookworm-arm64",
        "ubuntu-24.04-amd64",
    ]
