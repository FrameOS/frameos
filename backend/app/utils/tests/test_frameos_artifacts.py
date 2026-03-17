from pathlib import Path

from app.utils.frameos_artifacts import (
    normalize_release_version,
    resolve_versioned_artifact,
    versioned_artifact_name,
)


def test_versioned_artifact_name_normalizes_build_metadata() -> None:
    assert versioned_artifact_name("driver", "2026.3.3+abc123", ".so") == "driver.2026.3.3.so"


def test_resolve_versioned_artifact_returns_highest_compatible_release(tmp_path: Path) -> None:
    component_dir = tmp_path / "drivers" / "httpUpload"
    component_dir.mkdir(parents=True, exist_ok=True)
    (component_dir / "httpUpload.2026.3.1.so").write_bytes(b"1")
    (component_dir / "httpUpload.2026.3.2.so").write_bytes(b"2")
    (component_dir / "httpUpload.2026.3.5.so").write_bytes(b"5")

    resolved = resolve_versioned_artifact(
        component_dir,
        stem="httpUpload",
        suffix=".so",
        requested_version="2026.3.3",
    )

    assert resolved == component_dir / "httpUpload.2026.3.2.so"


def test_resolve_versioned_artifact_can_require_exact_runtime_match(tmp_path: Path) -> None:
    runtime_dir = tmp_path / "runtime"
    runtime_dir.mkdir(parents=True, exist_ok=True)
    (runtime_dir / "frameos.2026.3.2").write_bytes(b"2")
    (runtime_dir / "frameos.2026.3.3").write_bytes(b"3")

    assert normalize_release_version("2026.3.3+deadbeef") == "2026.3.3"
    assert resolve_versioned_artifact(
        runtime_dir,
        stem="frameos",
        suffix="",
        requested_version="2026.3.3",
        exact=True,
    ) == runtime_dir / "frameos.2026.3.3"
