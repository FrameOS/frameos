import hashlib
import json
from pathlib import Path

from app.utils.prebuilt_cross import read_frameos_version, write_artifact_manifest


def test_read_frameos_version_returns_raw_and_base(tmp_path: Path):
    (tmp_path / "versions.json").write_text(
        json.dumps({"frameos": "2026.3.3+421afc9595d20c10d8d684c01bc8b798e428d005"}) + "\n",
        encoding="utf-8",
    )

    assert read_frameos_version(tmp_path, field="raw") == "2026.3.3+421afc9595d20c10d8d684c01bc8b798e428d005"
    assert read_frameos_version(tmp_path, field="base") == "2026.3.3"


def test_write_artifact_manifest_lists_relative_paths_and_md5s(tmp_path: Path):
    root = tmp_path / "prebuilt-cross" / "2026.3.3" / "debian-bookworm-arm64"
    drivers_dir = root / "drivers"
    drivers_dir.mkdir(parents=True, exist_ok=True)
    frameos_path = root / "frameos"
    driver_path = drivers_dir / "httpUpload.so"
    metadata_path = root / "metadata.json"
    existing_manifest = root / "manifest.json"

    frameos_path.write_bytes(b"frameos")
    driver_path.write_bytes(b"plugin")
    metadata_path.write_text('{"target":"debian-bookworm-arm64"}\n', encoding="utf-8")
    existing_manifest.write_text("stale\n", encoding="utf-8")

    manifest_path = write_artifact_manifest(
        root,
        frameos_version="2026.3.3",
        source_version="2026.3.3+421afc9595d20c10d8d684c01bc8b798e428d005",
        target="debian-bookworm-arm64",
    )

    payload = json.loads(manifest_path.read_text(encoding="utf-8"))

    assert manifest_path == existing_manifest
    assert payload["frameos_version"] == "2026.3.3"
    assert payload["source_version"] == "2026.3.3+421afc9595d20c10d8d684c01bc8b798e428d005"
    assert payload["target"] == "debian-bookworm-arm64"
    assert payload["artifacts"] == [
        {
            "path": "drivers/httpUpload.so",
            "md5": hashlib.md5(b"plugin").hexdigest(),
        },
        {
            "path": "frameos",
            "md5": hashlib.md5(b"frameos").hexdigest(),
        },
        {
            "path": "metadata.json",
            "md5": hashlib.md5(b'{"target":"debian-bookworm-arm64"}\n').hexdigest(),
        },
    ]
