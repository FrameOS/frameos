import importlib.util
import json
import sys
from pathlib import Path


def load_buildroot_images_module():
    path = Path(__file__).resolve().parents[4] / "tools" / "buildroot-images" / "buildroot_images.py"
    spec = importlib.util.spec_from_file_location("buildroot_images", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_release_image_frame_uses_hotspot_without_wifi_credentials():
    module = load_buildroot_images_module()
    frame = module.ReleaseImageFrame()
    frame_json = module.get_frame_json(None, frame)

    assert frame.mode == "buildroot"
    assert frame.device == "framebuffer"
    assert frame.network.get("wifiSSID") is None
    assert frame.network.get("wifiPassword") is None
    assert frame_json["network"]["networkCheck"] is True
    assert frame_json["network"]["wifiHotspot"] == "bootOnly"
    assert frame_json["network"]["wifiHotspotSsid"] == "FrameOS-Setup"
    assert frame_json["device"] == "framebuffer"


def test_find_precompiled_artifact_root_prefers_matching_metadata(tmp_path):
    module = load_buildroot_images_module()
    artifact_root = tmp_path / "frameos-2026.6.2-debian-bookworm-arm64"
    artifact_root.mkdir()
    (artifact_root / "frameos").write_bytes(b"frameos")
    (artifact_root / "frameos_agent").write_bytes(b"agent")
    (artifact_root / "metadata.json").write_text(
        json.dumps({"slug": "debian-bookworm-arm64"}),
        encoding="utf-8",
    )

    assert module._find_precompiled_artifact_root(tmp_path, "debian-bookworm-arm64") == artifact_root


def test_precompiled_archive_path_accepts_downloaded_release_asset(tmp_path):
    module = load_buildroot_images_module()
    archive = tmp_path / "frameos-2026.6.2-debian-bookworm-arm64.tar.gz"
    archive.write_bytes(b"archive")

    assert module._precompiled_archive_path(tmp_path, "debian-bookworm-arm64", "2026.6.2") == archive
