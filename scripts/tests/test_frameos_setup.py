from __future__ import annotations

import json
import os
import shutil
import subprocess
import tarfile
import tempfile
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SETUP_SCRIPT = ROOT / "scripts" / "frameos-setup.sh"
IMAGE = os.environ.get("FRAMEOS_SETUP_TEST_IMAGE", "python:3.12-slim-bookworm")
VERSION = "2026.6.8"
TARGET = "debian-bookworm-amd64"


class FrameOSSetupScriptTest(unittest.TestCase):
    def setUp(self) -> None:
        if not shutil.which("docker"):
            self.skipTest("docker is required for setup script container tests")
        docker_info = subprocess.run(
            ["docker", "info"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if docker_info.returncode != 0:
            self.skipTest("docker daemon is required for setup script container tests")
        self.tmp = tempfile.TemporaryDirectory(prefix="frameos-setup-test-")
        self.tmp_path = Path(self.tmp.name)
        self.releases_dir = self.tmp_path / "releases"
        self.out_dir = self.tmp_path / "out"
        self._write_fake_release_archive()
        self._write_stubs()

    def tearDown(self) -> None:
        self._restore_tmp_permissions()
        self.tmp.cleanup()

    def test_standalone_install_writes_frame_json_and_starts_frameos_only(self) -> None:
        result = self._run_setup(
            {
                "FRAMEOS_NAME": "Standalone Frame",
                "FRAMEOS_DEVICE": "waveshare.EPD_7in3e",
                "FRAMEOS_WIDTH": "800",
                "FRAMEOS_HEIGHT": "480",
                "FRAMEOS_ROTATE": "90",
                "FRAMEOS_FRAME_PORT": "8787",
                "FRAMEOS_TIME_ZONE": "Europe/Brussels",
                "FRAMEOS_ADMIN_AUTH_ENABLED": "true",
                "FRAMEOS_ADMIN_USER": "admin",
                "FRAMEOS_ADMIN_PASSWORD": "admin-secret",
                "FRAMEOS_BACKEND_ENABLED": "false",
                "FRAMEOS_FRAME_ACCESS_KEY": "local-access-key",
                "FRAMEOS_NETWORK_CHECK": "false",
                "FRAMEOS_WIFI_HOTSPOT": "disabled",
                "FRAMEOS_SAVE_ASSETS": "true",
            }
        )

        self.assertIn("Backend: not configured; FrameOS will run standalone.", result.stdout)
        frame_json = self._installed_frame_json()
        self.assertEqual(frame_json["name"], "Standalone Frame")
        self.assertEqual(frame_json["device"], "waveshare.EPD_7in3e")
        self.assertEqual(frame_json["width"], 800)
        self.assertEqual(frame_json["height"], 480)
        self.assertEqual(frame_json["rotate"], 90)
        self.assertEqual(frame_json["interval"], 300.0)
        self.assertEqual(frame_json["metricsInterval"], 60.0)
        self.assertEqual(frame_json["timeZone"], "Europe/Brussels")
        self.assertEqual(frame_json["frameAdminAuth"], {
            "enabled": True,
            "user": "admin",
            "pass": "admin-secret",
        })
        self.assertEqual(frame_json["agent"]["agentEnabled"], False)
        self.assertEqual(frame_json["agent"]["agentRunCommands"], False)
        self.assertEqual(frame_json["serverSendLogs"], False)

        systemctl_calls = self._stub_log("systemctl.log")
        self.assertIn("enable frameos.service", systemctl_calls)
        self.assertIn("restart frameos.service", systemctl_calls)
        self.assertIn("disable --now frameos_agent.service", systemctl_calls)
        self.assertNotIn("restart frameos_agent.service", systemctl_calls)

        checks = self._container_checks()
        self.assertTrue(checks["frameos_service_installed"])
        self.assertFalse(checks["agent_service_installed"])
        self.assertNotIn("TTYPath=/dev/tty1", self._installed_frameos_service())

    def test_framebuffer_install_claims_tty1(self) -> None:
        self._run_setup(
            {
                "FRAMEOS_NAME": "Framebuffer Frame",
                "FRAMEOS_DEVICE": "framebuffer",
                "FRAMEOS_WIDTH": "1920",
                "FRAMEOS_HEIGHT": "1080",
                "FRAMEOS_FRAME_PORT": "8787",
                "FRAMEOS_BACKEND_ENABLED": "false",
                "FRAMEOS_FRAME_ACCESS_KEY": "local-access-key",
                "FRAMEOS_NETWORK_CHECK": "false",
                "FRAMEOS_WIFI_HOTSPOT": "disabled",
            }
        )

        service = self._installed_frameos_service()
        self.assertIn("After=network.target getty@tty1.service", service)
        self.assertIn("Conflicts=getty@tty1.service", service)
        self.assertIn("TTYPath=/dev/tty1", service)
        self.assertIn("StandardInput=tty-force", service)
        self.assertIn("TTYReset=yes", service)
        self.assertIn(
            "ExecStopPost=-+/bin/systemd-run --quiet --collect --on-active=3 /bin/systemctl reset-failed getty@tty1.service",
            service,
        )
        self.assertIn(
            "ExecStopPost=-+/bin/systemd-run --quiet --collect --on-active=4 /bin/systemctl start getty@tty1.service",
            service,
        )
        self.assertNotIn("python3 -c", service)
        self.assertNotIn("TTYVHangup=yes", service)
        self.assertNotIn("TTYVTDisallocate=yes", service)

    def test_existing_frame_json_defaults_enable_backend_agent(self) -> None:
        existing_dir = self.out_dir / "srv" / "frameos" / "current"
        existing_dir.mkdir(parents=True)
        (existing_dir / "frame.json").write_text(
            json.dumps(
                {
                    "name": "Existing Frame",
                    "device": "web_only",
                    "width": 1024,
                    "height": 600,
                    "framePort": 8888,
                    "frameAccessKey": "existing-access",
                    "frameAdminAuth": {
                        "enabled": True,
                        "user": "owner",
                        "pass": "existing-admin-pass",
                    },
                    "serverHost": "backend.example",
                    "serverPort": 9443,
                    "serverApiKey": "server-api-key",
                    "serverSendLogs": True,
                    "agent": {
                        "agentEnabled": True,
                        "agentRunCommands": True,
                        "agentSharedSecret": "agent-shared-secret",
                    },
                    "network": {
                        "networkCheck": True,
                        "wifiHotspot": "bootOnly",
                        "wifiHotspotSsid": "Existing-Setup",
                        "wifiHotspotPassword": "existing-wifi-pass",
                    },
                    "schedule": {"events": [{"id": "keep-me"}]},
                }
            )
            + "\n",
            encoding="utf-8",
        )

        result = self._run_setup({})

        self.assertIn("Backend: backend.example:9443", result.stdout)
        frame_json = self._installed_frame_json()
        self.assertEqual(frame_json["name"], "Existing Frame")
        self.assertEqual(frame_json["device"], "web_only")
        self.assertEqual(frame_json["framePort"], 8888)
        self.assertEqual(frame_json["frameAccessKey"], "existing-access")
        self.assertEqual(frame_json["frameAdminAuth"]["pass"], "existing-admin-pass")
        self.assertEqual(frame_json["serverHost"], "backend.example")
        self.assertEqual(frame_json["serverPort"], 9443)
        self.assertEqual(frame_json["serverApiKey"], "server-api-key")
        self.assertEqual(frame_json["serverSendLogs"], True)
        self.assertEqual(frame_json["agent"], {
            "agentEnabled": True,
            "agentRunCommands": True,
            "agentSharedSecret": "agent-shared-secret",
        })
        self.assertEqual(frame_json["network"]["wifiHotspot"], "bootOnly")
        self.assertEqual(frame_json["schedule"], {"events": [{"id": "keep-me"}]})

        systemctl_calls = self._stub_log("systemctl.log")
        self.assertIn("enable frameos_agent.service", systemctl_calls)
        self.assertIn("restart frameos_agent.service", systemctl_calls)

        checks = self._container_checks()
        self.assertTrue(checks["frameos_service_installed"])
        self.assertTrue(checks["agent_service_installed"])

    def test_device_menu_prints_real_newlines(self) -> None:
        menu = subprocess.run(
            [
                "docker",
                "run",
                "--rm",
                "--volume",
                f"{ROOT}:/repo:ro",
                "--platform",
                "linux/amd64",
                IMAGE,
                "/bin/sh",
                "-lc",
                "awk '/^copy_scene_payloads\\(\\) /{exit} {print}' /repo/scripts/frameos-setup.sh > /tmp/functions.sh "
                "&& . /tmp/functions.sh "
                "&& printf '\\n' | choose_device web_only >/tmp/device",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=90,
        )
        if menu.returncode != 0:
            self.fail(
                "device menu container failed\n"
                f"return code: {menu.returncode}\n"
                f"stdout:\n{menu.stdout}\n"
                f"stderr:\n{menu.stderr}\n"
            )
        self.assertIn("Device choices:\n  1) web_only", menu.stderr)
        self.assertIn("4) pimoroni.inky_impression_7_2025", menu.stderr)
        self.assertIn("5) pimoroni.inky_impression_13_2025", menu.stderr)
        self.assertIn("6) waveshare.EPD_7in3e", menu.stderr)
        self.assertIn("7) waveshare.EPD_13in3e", menu.stderr)
        self.assertIn("8) waveshare.EPD_7in5_V2", menu.stderr)
        self.assertNotIn("\\nDevice choices", menu.stderr)
        self.assertNotIn("custom device key\\nDevice", menu.stderr)

    def _write_fake_release_archive(self) -> None:
        artifact_root = self.tmp_path / "artifact" / f"frameos-{VERSION}-{TARGET}"
        artifact_root.mkdir(parents=True)
        (artifact_root / "metadata.json").write_text(json.dumps({"slug": TARGET}) + "\n", encoding="utf-8")
        (artifact_root / "drivers").mkdir()
        (artifact_root / "drivers" / "driver-marker").write_text("driver\n", encoding="utf-8")
        (artifact_root / "scenes").mkdir()
        (artifact_root / "scenes" / "scene-marker").write_text("scene\n", encoding="utf-8")
        (artifact_root / "vendor").mkdir()
        (artifact_root / "vendor" / "vendor-marker").write_text("vendor\n", encoding="utf-8")
        self._write_executable(
            artifact_root / "frameos",
            """#!/bin/sh
            echo "$@" >> /tmp/out/frameos-binary.log
            if [ "${1:-}" = "setup" ]; then
              exit "${FRAMEOS_STUB_SETUP_EXIT:-0}"
            fi
            exit 0
            """,
        )
        self._write_executable(
            artifact_root / "frameos_agent",
            """#!/bin/sh
            echo "$@" >> /tmp/out/frameos-agent-binary.log
            exit 0
            """,
        )

        release_version_dir = self.releases_dir / f"v{VERSION}"
        release_version_dir.mkdir(parents=True)
        archive_path = release_version_dir / f"frameos-{VERSION}-{TARGET}.tar.gz"
        with tarfile.open(archive_path, "w:gz") as archive:
            archive.add(artifact_root, arcname=artifact_root.name)

    def _write_stubs(self) -> None:
        stub_dir = self.out_dir / "stubbin"
        stub_dir.mkdir(parents=True)
        self._write_executable(
            stub_dir / "curl",
            """#!/bin/sh
            destination=""
            url=""
            while [ "$#" -gt 0 ]; do
              case "$1" in
                -o)
                  destination="$2"
                  shift 2
                  ;;
                -*)
                  shift
                  ;;
                *)
                  url="$1"
                  shift
                  ;;
              esac
            done
            case "$url" in
              file://*) cp "${url#file://}" "$destination" ;;
              *) echo "unsupported test URL: $url" >&2; exit 1 ;;
            esac
            """,
        )
        self._write_executable(
            stub_dir / "apt-get",
            """#!/bin/sh
            echo "$@" >> /tmp/out/apt-get.log
            exit 0
            """,
        )
        self._write_executable(
            stub_dir / "dpkg-query",
            """#!/bin/sh
            exit 1
            """,
        )
        self._write_executable(
            stub_dir / "systemctl",
            """#!/bin/sh
            echo "$@" >> /tmp/out/systemctl.log
            exit 0
            """,
        )

    def _run_setup(self, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
        merged_env = {
            "FRAMEOS_RELEASE_VERSION": VERSION,
            "FRAMEOS_RELEASE_BASE_URL": "file:///tmp/releases",
            "FRAMEOS_DIR": "/tmp/out/srv/frameos",
            "FRAMEOS_AGENT_DIR": "/tmp/out/srv/frameos/agent",
            "FRAMEOS_ASSETS_DIR": "/tmp/out/srv/assets",
            "FRAMEOS_NETWORK_CHECK_TIMEOUT_SECONDS": "30",
            "FRAMEOS_NETWORK_CHECK_URL": "https://networkcheck.frameos.net/",
            "FRAMEOS_WIFI_HOTSPOT_TIMEOUT_SECONDS": "300",
            "FRAMEOS_MAX_HTTP_RESPONSE_BYTES": "67108864",
            "FRAMEOS_DEBUG": "false",
            "FRAMEOS_SCALING_MODE": "contain",
            "FRAMEOS_IMAGE_ENGINE": "",
            "FRAMEOS_FLIP": "",
            **env,
        }
        env_args = []
        for key, value in merged_env.items():
            env_args.extend(["--env", f"{key}={value}"])

        command = (
            "PATH=/tmp/out/stubbin:$PATH /repo/scripts/frameos-setup.sh "
            "&& python3 - <<'PY'\n"
            "import json, os\n"
            "checks = {\n"
            "  'frameos_service_installed': os.path.isfile('/etc/systemd/system/frameos.service'),\n"
            "  'agent_service_installed': os.path.isfile('/etc/systemd/system/frameos_agent.service'),\n"
            "}\n"
            "open('/tmp/out/container-checks.json', 'w').write(json.dumps(checks))\n"
            "PY"
        )
        result = subprocess.run(
            [
                "docker",
                "run",
                "--rm",
                "--volume",
                f"{ROOT}:/repo:ro",
                "--volume",
                f"{self.releases_dir}:/tmp/releases:ro",
                "--volume",
                f"{self.out_dir}:/tmp/out",
                "--platform",
                "linux/amd64",
                *env_args,
                IMAGE,
                "/bin/sh",
                "-lc",
                command,
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=90,
        )
        if result.returncode != 0:
            self.fail(
                "setup container failed\n"
                f"return code: {result.returncode}\n"
                f"stdout:\n{result.stdout}\n"
                f"stderr:\n{result.stderr}\n"
            )
        return result

    def _installed_frame_json(self) -> dict:
        releases = sorted((self.out_dir / "srv" / "frameos" / "releases").glob("release_setup_*"))
        self.assertEqual(len(releases), 1)
        return json.loads((releases[0] / "frame.json").read_text(encoding="utf-8"))

    def _installed_frameos_service(self) -> str:
        releases = sorted((self.out_dir / "srv" / "frameos" / "releases").glob("release_setup_*"))
        self.assertEqual(len(releases), 1)
        return (releases[0] / "frameos.service").read_text(encoding="utf-8")

    def _container_checks(self) -> dict[str, bool]:
        return json.loads((self.out_dir / "container-checks.json").read_text(encoding="utf-8"))

    def _stub_log(self, name: str) -> str:
        path = self.out_dir / name
        return path.read_text(encoding="utf-8") if path.exists() else ""

    def _restore_tmp_permissions(self) -> None:
        if not shutil.which("docker") or not hasattr(self, "tmp_path"):
            return
        subprocess.run(
            [
                "docker",
                "run",
                "--rm",
                "--volume",
                f"{self.tmp_path}:/tmp/frameos-setup-test",
                "--platform",
                "linux/amd64",
                "--env",
                f"HOST_UID={os.getuid()}",
                "--env",
                f"HOST_GID={os.getgid()}",
                IMAGE,
                "/bin/sh",
                "-lc",
                'chown -R "$HOST_UID:$HOST_GID" /tmp/frameos-setup-test || true',
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=90,
        )

    @staticmethod
    def _write_executable(path: Path, contents: str) -> None:
        path.write_text(textwrap.dedent(contents).lstrip(), encoding="utf-8")
        path.chmod(0o755)


if __name__ == "__main__":
    unittest.main(verbosity=2)
