import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest


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


def test_release_image_ships_frameos_remote_disabled():
    # docs/buildroot-privileges.md §2: a generic card has no backend to talk
    # to, so an enabled agent is a root process reconnecting to ws://:8989
    # forever. The backend that adopts the card turns it on (and mints the
    # secret) on its first deploy. The empty secret stays empty — that is the
    # fail-closed state, not a hole.
    module = load_buildroot_images_module()
    frame = module.ReleaseImageFrame()
    frame_json = module.get_frame_json(None, frame)

    assert frame_json["agent"]["agentEnabled"] is False
    assert frame_json["agent"]["agentSharedSecret"] == ""
    assert frame_json["serverHost"] == ""


def test_base_bootstrap_overlay_enables_frameos_service(tmp_path):
    module = load_buildroot_images_module()

    module.write_base_bootstrap_overlay(tmp_path)

    service = tmp_path / "etc" / "systemd" / "system" / "frameos.service"
    wants_link = tmp_path / "etc" / "systemd" / "system" / "multi-user.target.wants" / "frameos.service"

    assert service.is_file()
    service_text = service.read_text(encoding="utf-8")
    assert "User=root" in service_text
    assert "ExecStart=/srv/frameos/current/frameos" in service_text
    assert "Environment=FRAMEOS_HOME=/srv/frameos/current" in service_text
    assert wants_link.is_symlink()
    assert wants_link.readlink().as_posix() == "../frameos.service"
    nm_connections_dir = tmp_path / module.BUILDROOT_NETWORK_MANAGER_CONNECTIONS_DIR.lstrip("/")
    assert nm_connections_dir.is_dir()
    nm_state_dir = tmp_path / module.BUILDROOT_NETWORK_MANAGER_STATE_CONNECTIONS_DIR.lstrip("/")
    assert nm_state_dir.is_dir()
    assert oct(nm_state_dir.stat().st_mode & 0o777) == "0o700"
    assert module.BUILDROOT_NETWORK_MANAGER_CONNECTIONS_FSTAB_LINE in (
        tmp_path / "etc" / "fstab"
    ).read_text(encoding="utf-8")


def test_find_precompiled_artifact_root_prefers_matching_metadata(tmp_path):
    module = load_buildroot_images_module()
    artifact_root = tmp_path / "frameos-2026.6.2-debian-bookworm-arm64"
    artifact_root.mkdir()
    (artifact_root / "frameos").write_bytes(b"frameos")
    (artifact_root / "frameos_remote").write_bytes(b"agent")
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


@pytest.mark.asyncio
async def test_release_image_composes_with_executor_when_host_tools_are_missing(tmp_path, monkeypatch):
    module = load_buildroot_images_module()
    target = "debian-bookworm-arm64"
    prebuilt_dir = tmp_path / "prebuilt-cross"
    artifact_root = prebuilt_dir / target
    release_assets_dir = tmp_path / "release-assets"
    artifact_root.mkdir(parents=True)
    (artifact_root / "frameos").write_bytes(b"frameos")
    (artifact_root / "frameos_remote").write_bytes(b"agent")
    (artifact_root / "metadata.json").write_text(
        json.dumps({"slug": target, "compilation_mode": "shared"}),
        encoding="utf-8",
    )
    base_image_path = tmp_path / "base.img"
    base_image_path.write_bytes(b"base image")
    calls: dict[str, object] = {}

    class FakeExecutor:
        def __init__(self) -> None:
            self.entered = False
            self.exited = False

        async def __aenter__(self):
            self.entered = True
            return self

        async def __aexit__(self, exc_type, exc, tb):
            self.exited = True

    fake_executor = FakeExecutor()

    def fake_create_build_executor(config, **kwargs):
        calls["create_config"] = config
        calls["create_kwargs"] = kwargs
        return fake_executor

    async def fake_resolve_buildroot_base_entry(platform):
        calls["platform"] = platform
        return {
            "frameos_version": "2026.6.1",
            "object_key": "buildroot-images/raspberry-pi-64/base.img.gz",
            "sha256": "base-sha",
            "updated_at": "2026-06-01T00:00:00+00:00",
        }

    async def fake_ensure_buildroot_base_image(_entry, _cache_dir):
        return base_image_path

    async def fake_ensure_buildroot_image(self):
        assert self.executor is fake_executor
        calls["ensure_image"] = True
        return "frameos/frameos-buildroot:test"

    async def fake_compose_sd_image_from_base(self, *, temp_dir, base_image_path: Path, output_path, image):
        assert self.executor is fake_executor
        assert image == "frameos/frameos-buildroot:test"
        assert base_image_path == calls["base_image_path"]
        overlay = temp_dir / "overlay"
        # Generic release images ship no per-frame setup payload...
        assert not (overlay / "boot" / "frameos-setup.json").exists()
        assert not (overlay / "boot" / "frameos-wifi.nmconnection").exists()
        # ...but they DO ship the canonical 4096-byte all-comments
        # frameos-cloud.txt placeholder that the in-browser personalizer
        # patches in place (byte-exact: magic first line + fixed size).
        placeholder = (overlay / "boot" / "frameos-cloud.txt").read_bytes()
        assert placeholder == module.render_cloud_config_placeholder()
        assert len(placeholder) == 4096
        assert placeholder.startswith(b"# FRAMEOS-CLOUD-CONFIG-V1\n")
        # ...but the first-boot service and script stay staged and dormant,
        # armed for both frameos-setup.json and frameos-cloud.txt.
        script_path = overlay / "usr" / "local" / "bin" / "frameos-setup-reset.sh"
        assert script_path.is_file()
        script_text = script_path.read_text(encoding="utf-8")
        assert "cloud_enroll_pending.json" in script_text
        assert 'CLOUD_FILE="$BOOT_DIR"/frameos-cloud.txt' in script_text
        service_path = overlay / "etc" / "systemd" / "system" / "frameos-firstboot-setup.service"
        service_text = service_path.read_text(encoding="utf-8")
        assert "ConditionPathExists=|/boot/frameos-setup.json" in service_text
        assert "ConditionPathExists=|/boot/frameos-cloud.txt" in service_text
        wants_link = (
            overlay / "etc" / "systemd" / "system" / "multi-user.target.wants" / "frameos-firstboot-setup.service"
        )
        assert wants_link.is_symlink()
        # Without embedded WiFi the captive portal must still come up.
        frame_json = json.loads(
            (overlay / "srv" / "frameos" / "releases" / "release_2026.6.2" / "frame.json").read_text(
                encoding="utf-8"
            )
        )
        assert frame_json["network"]["wifiHotspot"] == "bootOnly"
        output_path.write_bytes(b"release raw image")
        calls["compose_image"] = image

    monkeypatch.setattr(module.ReleaseBuildrootImageBuilder, "_host_has_compose_tools", staticmethod(lambda: False))
    monkeypatch.setattr(module.ReleaseBuildrootImageBuilder, "_ensure_buildroot_image", fake_ensure_buildroot_image)
    monkeypatch.setattr(
        module.ReleaseBuildrootImageBuilder,
        "_compose_sd_image_from_base",
        fake_compose_sd_image_from_base,
    )
    monkeypatch.setattr(module, "create_build_executor", fake_create_build_executor)
    monkeypatch.setattr(module, "resolve_buildroot_base_entry", fake_resolve_buildroot_base_entry)
    monkeypatch.setattr(module, "ensure_buildroot_base_image", fake_ensure_buildroot_base_image)
    calls["base_image_path"] = base_image_path

    await module.build_release_image(
        SimpleNamespace(
            platform="raspberry-pi-64",
            prebuilt_cross_dir=str(prebuilt_dir),
            release_assets_dir=str(release_assets_dir),
            target=target,
            version="2026.6.2",
        )
    )

    assert calls["create_config"] is None
    assert calls["ensure_image"] is True
    assert calls["compose_image"] == "frameos/frameos-buildroot:test"
    assert fake_executor.entered is True
    assert fake_executor.exited is True
    assert (release_assets_dir / "frameos-2026.6.2-raspberry-pi-64-buildroot.img.gz").is_file()
    metadata = json.loads(
        (release_assets_dir / "frameos-2026.6.2-raspberry-pi-64-buildroot.img.metadata.json").read_text(
            encoding="utf-8"
        )
    )
    assert metadata["release_version"] == "2026.6.2"
    assert metadata["base_image"]["sha256"] == "base-sha"
