from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from app.utils.frameos_artifacts import resolve_versioned_artifact
from app.utils.prebuilt_cross import file_md5sum, split_version_base, write_artifact_manifest


DEFAULT_REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CROSS_SCRIPT = DEFAULT_REPO_ROOT / "backend" / "bin" / "cross"


@dataclass(frozen=True)
class ReleaseBuildPlan:
    frameos_version: str
    frameos_release_version: str
    targets: tuple[str, ...]
    jobs: int
    target_jobs: int
    driver_jobs: int


@dataclass(frozen=True)
class TargetBuildMetrics:
    target: str
    duration_seconds: float
    total_size_bytes: int
    frameos_size_bytes: int
    drivers_size_bytes: int
    driver_count: int
    artifact_count: int


@dataclass(frozen=True)
class ReleaseBuildResult:
    release_dir: Path
    metrics_path: Path
    target_metrics: tuple[TargetBuildMetrics, ...]
    total_duration_seconds: float
    total_size_bytes: int


def _require_positive(name: str, value: int | None) -> int | None:
    if value is None:
        return None
    if value < 1:
        raise ValueError(f"{name} must be at least 1")
    return value


def available_targets(
    *,
    repo_root: Path = DEFAULT_REPO_ROOT,
    cross_script: Path = DEFAULT_CROSS_SCRIPT,
    python_executable: str = sys.executable,
) -> tuple[str, ...]:
    result = subprocess.run(
        [python_executable, str(cross_script), "list"],
        cwd=repo_root,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        message = (result.stderr or result.stdout or "unknown error").strip()
        raise RuntimeError(f"Failed to list cross targets: {message}")
    return tuple(line.strip() for line in result.stdout.splitlines() if line.strip())


def resolve_release_build_plan(
    *,
    frameos_version: str,
    requested_targets: Sequence[str],
    available_target_slugs: Sequence[str],
    jobs: int | None = None,
    target_jobs: int | None = None,
    driver_jobs: int | None = None,
) -> ReleaseBuildPlan:
    cleaned_version = frameos_version.strip()
    if not cleaned_version:
        raise ValueError("frameos_version must not be empty")

    total_jobs = _require_positive("jobs", jobs) or (os.cpu_count() or 1)
    requested_target_jobs = _require_positive("target_jobs", target_jobs)
    requested_driver_jobs = _require_positive("driver_jobs", driver_jobs)

    known_targets = tuple(available_target_slugs)
    known_target_set = set(known_targets)

    deduped_targets: list[str] = []
    seen_targets: set[str] = set()
    source_targets = requested_targets or known_targets
    for target in source_targets:
        if target in seen_targets:
            continue
        seen_targets.add(target)
        deduped_targets.append(target)

    if not deduped_targets:
        raise ValueError("No cross-compilation targets are available")

    invalid_targets = [target for target in deduped_targets if target not in known_target_set]
    if invalid_targets:
        valid = ", ".join(sorted(known_targets))
        raise ValueError(f"Unknown target(s): {', '.join(invalid_targets)}. Valid targets: {valid}")

    resolved_target_jobs = min(len(deduped_targets), requested_target_jobs or 1)
    resolved_driver_jobs = requested_driver_jobs or (
        total_jobs if requested_target_jobs is None else max(1, total_jobs // resolved_target_jobs)
    )
    frameos_release_version = split_version_base(cleaned_version) or cleaned_version

    return ReleaseBuildPlan(
        frameos_version=cleaned_version,
        frameos_release_version=frameos_release_version,
        targets=tuple(deduped_targets),
        jobs=total_jobs,
        target_jobs=resolved_target_jobs,
        driver_jobs=resolved_driver_jobs,
    )


async def _stream_prefixed_output(prefix: str, stream: asyncio.StreamReader | None) -> None:
    if stream is None:
        return

    while True:
        raw_line = await stream.readline()
        if not raw_line:
            break
        line = raw_line.decode("utf-8", errors="replace").rstrip("\n")
        print(f"[{prefix}] {line}", flush=True)


async def _stop_process_tree(process: asyncio.subprocess.Process, *, timeout: float = 5.0) -> None:
    if process.returncode is not None:
        return

    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return

    try:
        await asyncio.wait_for(process.wait(), timeout=timeout)
        return
    except asyncio.TimeoutError:
        pass

    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        return
    await process.wait()


async def _run_prefixed_command(
    *,
    prefix: str,
    argv: Sequence[str],
    cwd: Path,
    env: dict[str, str],
) -> None:
    process = await asyncio.create_subprocess_exec(
        *argv,
        cwd=str(cwd),
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        start_new_session=True,
    )

    output_task = asyncio.create_task(_stream_prefixed_output(prefix, process.stdout))
    try:
        return_code = await process.wait()
        await output_task
    except asyncio.CancelledError:
        output_task.cancel()
        await asyncio.gather(output_task, return_exceptions=True)
        await _stop_process_tree(process)
        raise

    if return_code != 0:
        command = " ".join(argv)
        raise RuntimeError(f"{prefix} failed with exit code {return_code}: {command}")


def _format_size(size: int) -> str:
    units = ["B", "KiB", "MiB", "GiB", "TiB"]
    value = float(size)
    for unit in units:
        if value < 1024 or unit == units[-1]:
            if unit == "B":
                return f"{int(value)} {unit}"
            return f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} TiB"


def _selected_target_artifacts(
    target_dir: Path,
    *,
    release_version: str,
) -> tuple[Path, ...]:
    artifacts: list[Path] = []

    metadata_path = target_dir / "metadata.json"
    if metadata_path.is_file():
        artifacts.append(metadata_path)

    runtime_path = resolve_versioned_artifact(
        target_dir / "frameos",
        stem="frameos",
        suffix="",
        requested_version=release_version,
        exact=True,
    )
    if runtime_path is None:
        runtime_path = resolve_versioned_artifact(
            target_dir / "runtime",
            stem="frameos",
            suffix="",
            requested_version=release_version,
            exact=True,
        )
    if runtime_path is None:
        legacy_runtime_path = target_dir / "frameos"
        if legacy_runtime_path.is_file():
            runtime_path = legacy_runtime_path
    if runtime_path is not None:
        artifacts.append(runtime_path)

    drivers_dir = target_dir / "drivers"
    if drivers_dir.is_dir():
        for component_dir in sorted(child for child in drivers_dir.iterdir() if child.is_dir()):
            selected_driver = resolve_versioned_artifact(
                component_dir,
                stem=component_dir.name,
                suffix=".so",
                requested_version=release_version,
            )
            if selected_driver is not None:
                artifacts.append(selected_driver)

    return tuple(artifacts)


def _write_selected_target_manifest(
    target_dir: Path,
    *,
    output: Path,
    release_version: str,
    source_version: str,
    target: str,
) -> tuple[Path, ...]:
    selected_artifacts = _selected_target_artifacts(target_dir, release_version=release_version)
    payload = {
        "frameos_version": release_version,
        "source_version": source_version,
        "target": target,
        "artifacts": [
            {
                "path": path.relative_to(target_dir).as_posix(),
                "md5": file_md5sum(path),
            }
            for path in selected_artifacts
        ],
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return selected_artifacts


def _collect_target_metrics(
    target: str,
    duration_seconds: float,
    *,
    selected_artifacts: Sequence[Path],
    target_manifest: Path,
) -> TargetBuildMetrics:
    frameos_size = 0
    drivers_size = 0
    driver_count = 0
    for path in selected_artifacts:
        if path.suffix == ".so":
            drivers_size += path.stat().st_size
            driver_count += 1
            continue
        if path.name.startswith("frameos"):
            frameos_size = path.stat().st_size

    selected_size = sum(path.stat().st_size for path in selected_artifacts)
    return TargetBuildMetrics(
        target=target,
        duration_seconds=duration_seconds,
        total_size_bytes=selected_size + target_manifest.stat().st_size,
        frameos_size_bytes=frameos_size,
        drivers_size_bytes=drivers_size,
        driver_count=driver_count,
        artifact_count=len(selected_artifacts) + 1,
    )


def _write_release_metrics(
    release_dir: Path,
    *,
    plan: ReleaseBuildPlan,
    target_metrics: Sequence[TargetBuildMetrics],
    total_duration_seconds: float,
) -> Path:
    metrics_path = release_dir / f"build-metrics.{plan.frameos_release_version}.json"
    payload = {
        "frameos_version": plan.frameos_release_version,
        "source_version": plan.frameos_version,
        "jobs": plan.jobs,
        "target_jobs": plan.target_jobs,
        "driver_jobs": plan.driver_jobs,
        "target_count": len(target_metrics),
        "total_duration_seconds": total_duration_seconds,
        "total_size_bytes": sum(metrics.total_size_bytes for metrics in target_metrics),
        "targets": [
            {
                "target": metrics.target,
                "duration_seconds": metrics.duration_seconds,
                "total_size_bytes": metrics.total_size_bytes,
                "frameos_size_bytes": metrics.frameos_size_bytes,
                "drivers_size_bytes": metrics.drivers_size_bytes,
                "driver_count": metrics.driver_count,
                "artifact_count": metrics.artifact_count,
            }
            for metrics in target_metrics
        ],
    }
    metrics_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return metrics_path


def _target_build_commands(
    *,
    target: str,
    plan: ReleaseBuildPlan,
    repo_root: Path,
    release_dir: Path,
    cross_script: Path,
    python_executable: str = sys.executable,
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    frameos_root = repo_root / "frameos"
    common = (
        python_executable,
        str(cross_script),
        "--target",
        target,
        "--frameos-root",
        str(frameos_root),
        "--artifacts-dir",
        str(release_dir),
    )
    build_frameos = (common[0], common[1], "build-frameos", *common[2:])
    build_drivers = (
        common[0],
        common[1],
        "build-drivers",
        *common[2:],
        "--release-version",
        plan.frameos_release_version,
        "--jobs",
        str(plan.driver_jobs),
    )
    build_frameos = (*build_frameos, "--release-version", plan.frameos_release_version)
    return build_frameos, build_drivers


async def _run_target_build(
    *,
    target: str,
    plan: ReleaseBuildPlan,
    repo_root: Path,
    release_dir: Path,
    cross_script: Path,
    python_executable: str = sys.executable,
) -> TargetBuildMetrics:
    env = os.environ.copy()
    env.setdefault("PYTHONUNBUFFERED", "1")
    target_dir = release_dir / target
    target_manifest = target_dir / f"manifest.{plan.frameos_release_version}.json"
    target_manifest.unlink(missing_ok=True)

    frameos_command, drivers_command = _target_build_commands(
        target=target,
        plan=plan,
        repo_root=repo_root,
        release_dir=release_dir,
        cross_script=cross_script,
        python_executable=python_executable,
    )

    started = time.perf_counter()
    print(f"[{target}] starting", flush=True)
    await _run_prefixed_command(
        prefix=target,
        argv=frameos_command,
        cwd=repo_root,
        env=env,
    )
    await _run_prefixed_command(
        prefix=target,
        argv=drivers_command,
        cwd=repo_root,
        env=env,
    )
    selected_artifacts = _write_selected_target_manifest(
        target_dir,
        output=target_manifest,
        release_version=plan.frameos_release_version,
        source_version=plan.frameos_version,
        target=target,
    )
    metrics = _collect_target_metrics(
        target,
        time.perf_counter() - started,
        selected_artifacts=selected_artifacts,
        target_manifest=target_manifest,
    )

    print(
        f"[{target}] metrics: duration={metrics.duration_seconds:.1f}s "
        f"size={_format_size(metrics.total_size_bytes)} "
        f"frameos={_format_size(metrics.frameos_size_bytes)} "
        f"drivers={_format_size(metrics.drivers_size_bytes)} "
        f"driver-count={metrics.driver_count}",
        flush=True,
    )
    print(f"[{target}] finished", flush=True)
    return metrics


async def run_release_build(
    plan: ReleaseBuildPlan,
    *,
    repo_root: Path = DEFAULT_REPO_ROOT,
    cross_script: Path = DEFAULT_CROSS_SCRIPT,
) -> ReleaseBuildResult:
    repo_root = repo_root.resolve()
    cross_script = cross_script.resolve()
    if not cross_script.is_file():
        raise RuntimeError(f"Expected cross script at {cross_script}")

    release_dir = repo_root / "files"
    release_dir.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()

    semaphore = asyncio.Semaphore(plan.target_jobs)
    target_results: list[TargetBuildMetrics | None] = [None] * len(plan.targets)

    async def run_with_limit(index: int, target: str) -> None:
        async with semaphore:
            target_results[index] = await _run_target_build(
                target=target,
                plan=plan,
                repo_root=repo_root,
                release_dir=release_dir,
                cross_script=cross_script,
            )

    tasks = [asyncio.create_task(run_with_limit(index, target)) for index, target in enumerate(plan.targets)]
    try:
        await asyncio.gather(*tasks)
    except Exception:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise

    write_artifact_manifest(
        release_dir,
        output=release_dir / f"manifest.{plan.frameos_release_version}.json",
        frameos_version=plan.frameos_release_version,
        source_version=plan.frameos_version,
    )
    ordered_target_metrics = tuple(metrics for metrics in target_results if metrics is not None)
    total_duration_seconds = time.perf_counter() - started
    metrics_path = _write_release_metrics(
        release_dir,
        plan=plan,
        target_metrics=ordered_target_metrics,
        total_duration_seconds=total_duration_seconds,
    )
    return ReleaseBuildResult(
        release_dir=release_dir,
        metrics_path=metrics_path,
        target_metrics=ordered_target_metrics,
        total_duration_seconds=total_duration_seconds,
        total_size_bytes=sum(metrics.total_size_bytes for metrics in ordered_target_metrics),
    )


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Parallel FrameOS binary release builder")
    parser.add_argument("frameos_version", help="FrameOS version or release to stamp into the build")
    parser.add_argument("targets", nargs="*", help="Optional target slugs to build; defaults to all known targets")
    parser.add_argument(
        "--target",
        action="append",
        default=[],
        help="Build only the specified target. Repeat to build multiple targets.",
    )
    parser.add_argument(
        "--jobs",
        type=int,
        default=None,
        help="Overall parallelism budget. Defaults to detected CPU count.",
    )
    parser.add_argument(
        "--target-jobs",
        type=int,
        default=None,
        help="Maximum number of targets to build concurrently. Defaults to 1.",
    )
    parser.add_argument(
        "--driver-jobs",
        type=int,
        default=None,
        help="Driver batches to run concurrently inside each target. Defaults to --jobs when target-jobs is implicit.",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str], *, repo_root: Path = DEFAULT_REPO_ROOT) -> int:
    args = parse_args(argv)
    requested_targets = tuple(args.targets) + tuple(args.target or ())
    try:
        plan = resolve_release_build_plan(
            frameos_version=args.frameos_version,
            requested_targets=requested_targets,
            available_target_slugs=available_targets(repo_root=repo_root),
            jobs=args.jobs,
            target_jobs=args.target_jobs,
            driver_jobs=args.driver_jobs,
        )
    except (RuntimeError, ValueError) as exc:
        raise SystemExit(str(exc)) from exc

    print(
        "Building FrameOS binary release "
        f"{plan.frameos_release_version} from {plan.frameos_version} "
        f"for {len(plan.targets)} target(s) "
        f"(target-jobs={plan.target_jobs}, driver-jobs={plan.driver_jobs}, jobs={plan.jobs})",
        flush=True,
    )

    try:
        result = asyncio.run(run_release_build(plan, repo_root=repo_root))
    except RuntimeError as exc:
        raise SystemExit(str(exc)) from exc

    print(
        f"Release build complete: {result.release_dir} "
        f"(duration={result.total_duration_seconds:.1f}s, size={_format_size(result.total_size_bytes)}, metrics={result.metrics_path})",
        flush=True,
    )
    return 0
