#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import contextlib
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
from typing import Any
import uuid
import zlib


REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = REPO_ROOT / "backend"
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
DEFAULT_RUNTIME_PACKAGES = (
    "ca-certificates",
    "libffi8",
    "libfreetype6",
    "libevdev2",
    "zlib1g",
    "libgcc-s1",
    "libstdc++6",
)
OPTIONAL_RUNTIME_PACKAGES = (
    "libssl3",
    "libssl3t64",
    "libjpeg62-turbo",
    "libjpeg-turbo8",
)


@dataclass(slots=True)
class UploadCapture:
    expected_path: str
    expected_token: str
    event: threading.Event
    body: bytes | None = None
    content_type: str | None = None
    path: str | None = None
    error: str | None = None


class CaptureServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, server_address: tuple[str, int], capture: UploadCapture):
        super().__init__(server_address, CaptureHandler)
        self.capture = capture


class CaptureHandler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:  # noqa: A003
        return

    def do_POST(self) -> None:  # noqa: N802
        capture: UploadCapture = self.server.capture  # type: ignore[attr-defined]
        try:
            path = self.path
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length)
            token = self.headers.get("X-FrameOS-Test-Token", "")
            content_type = self.headers.get("Content-Type", "")

            if path != capture.expected_path:
                capture.error = f"unexpected upload path: {path}"
                self.send_response(404)
                self.end_headers()
                capture.event.set()
                return

            if token != capture.expected_token:
                capture.error = "missing or invalid X-FrameOS-Test-Token header"
                self.send_response(401)
                self.end_headers()
                capture.event.set()
                return

            capture.body = body
            capture.content_type = content_type
            capture.path = path
            self.send_response(204)
            self.end_headers()
            capture.event.set()
        except Exception as exc:  # pragma: no cover - debugging path
            capture.error = str(exc)
            self.send_response(500)
            self.end_headers()
            capture.event.set()


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a real prebuilt FrameOS package end to end and verify HTTP upload output.",
    )
    parser.add_argument(
        "--target",
        required=True,
        help="Target slug under build/prebuilt-deps, for example debian-bookworm-arm64",
    )
    parser.add_argument(
        "--prebuilt-root",
        default=str(REPO_ROOT / "build" / "prebuilt-deps"),
        help="Root folder containing local prebuilt targets",
    )
    parser.add_argument(
        "--scene-mode",
        choices=("compiled", "interpreted"),
        default="compiled",
        help="Scene packaging mode. Compiled uses the cross-compile pipeline; interpreted reuses scenes.json only.",
    )
    parser.add_argument(
        "--runtime-image",
        default=None,
        help="Optional Docker image override. Defaults to the target metadata image.",
    )
    parser.add_argument(
        "--host-name",
        default="host.docker.internal",
        help="Host name the container should use to reach the upload capture server.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=45.0,
        help="Seconds to wait for the package to upload its rendered PNG.",
    )
    parser.add_argument(
        "--width",
        type=int,
        default=4,
        help="Expected frame width.",
    )
    parser.add_argument(
        "--height",
        type=int,
        default=3,
        help="Expected frame height.",
    )
    parser.add_argument(
        "--color",
        default="#123456",
        help="Hex color rendered by the verification scene.",
    )
    parser.add_argument(
        "--keep-temp",
        action="store_true",
        help="Keep the temporary package/build directory for inspection.",
    )
    return parser.parse_args(argv)


def read_target_metadata(prebuilt_root: Path, target_slug: str) -> tuple[Path, dict[str, Any], dict[str, dict[str, Any]]]:
    target_dir = prebuilt_root / target_slug
    metadata_path = target_dir / "metadata.json"
    if not metadata_path.is_file():
        raise RuntimeError(f"Missing prebuilt target metadata: {metadata_path}")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    components = metadata.get("components")
    if not isinstance(components, dict):
        raise RuntimeError(f"Invalid prebuilt metadata in {metadata_path}")
    return target_dir, metadata, components


def component_dir(target_dir: Path, components: dict[str, dict[str, Any]], component_name: str) -> Path:
    spec = components.get(component_name)
    if not isinstance(spec, dict):
        raise RuntimeError(f"Missing component '{component_name}' in {target_dir / 'metadata.json'}")
    directory = spec.get("directory")
    if not isinstance(directory, str) or not directory:
        raise RuntimeError(f"Invalid directory metadata for component '{component_name}'")
    path = target_dir / directory
    if not path.is_dir():
        raise RuntimeError(f"Missing component directory for '{component_name}': {path}")
    return path


def component_file(
    target_dir: Path,
    components: dict[str, dict[str, Any]],
    component_name: str,
    *,
    default_name: str | None = None,
) -> Path:
    spec = components.get(component_name)
    if not isinstance(spec, dict):
        raise RuntimeError(f"Missing component '{component_name}' in {target_dir / 'metadata.json'}")
    artifact = spec.get("artifact") or default_name or component_name
    if not isinstance(artifact, str) or not artifact:
        raise RuntimeError(f"Invalid artifact metadata for component '{component_name}'")
    path = component_dir(target_dir, components, component_name) / artifact
    if not path.is_file():
        raise RuntimeError(f"Missing artifact for component '{component_name}': {path}")
    return path


def rgb_triplet(color: str) -> tuple[int, int, int]:
    if not isinstance(color, str) or len(color) != 7 or not color.startswith("#"):
        raise RuntimeError(f"Invalid color value: {color!r}")
    try:
        return tuple(int(color[index : index + 2], 16) for index in (1, 3, 5))  # type: ignore[return-value]
    except ValueError as exc:
        raise RuntimeError(f"Invalid color value: {color!r}") from exc


def verification_scene(*, color: str, execution: str) -> dict[str, Any]:
    return {
        "id": "verify-color",
        "name": "Verify Color",
        "default": True,
        "fields": [],
        "nodes": [
            {
                "id": "event-render",
                "type": "event",
                "data": {"keyword": "render"},
            },
            {
                "id": "app-color",
                "type": "app",
                "data": {
                    "keyword": "render/color",
                    "config": {"color": color},
                },
            },
        ],
        "edges": [
            {
                "id": "edge-render-color",
                "source": "event-render",
                "sourceHandle": "next",
                "target": "app-color",
                "targetHandle": "prev",
                "type": "appNodeEdge",
            }
        ],
        "settings": {
            "backgroundColor": "#000000",
            "refreshInterval": 300.0,
            "execution": execution,
        },
    }


def verification_frame_json(
    *,
    width: int,
    height: int,
    upload_url: str,
    upload_token: str,
) -> dict[str, Any]:
    return {
        "name": "Prebuilt Package E2E",
        "mode": "web_only",
        "serverHost": "localhost",
        "serverPort": 8989,
        "serverApiKey": "api",
        "serverSendLogs": False,
        "frameHost": "0.0.0.0",
        "framePort": 8787,
        "httpsProxy": {
            "enable": False,
            "port": 8443,
            "exposeOnlyPort": False,
            "serverCert": "",
            "serverKey": "",
        },
        "frameAccess": "private",
        "frameAccessKey": "test-key",
        "frameAdminAuth": {},
        "width": width,
        "height": height,
        "device": "http.upload",
        "deviceConfig": {
            "uploadUrl": upload_url,
            "uploadHeaders": [
                {"name": "X-FrameOS-Test-Token", "value": upload_token},
            ],
        },
        "metricsInterval": 60,
        "rotate": 0,
        "flip": "",
        "scalingMode": "contain",
        "assetsPath": "/package/assets",
        "saveAssets": False,
        "logToFile": "",
        "debug": False,
        "timeZone": "UTC",
        "schedule": {"events": []},
        "gpioButtons": [],
        "controlCode": {
            "enabled": False,
            "position": "top-right",
            "size": 2,
            "padding": 1,
            "offsetX": 0,
            "offsetY": 0,
            "qrCodeColor": "#000000",
            "backgroundColor": "#ffffff",
        },
        "network": {
            "networkCheck": False,
            "networkCheckTimeoutSeconds": 30,
            "networkCheckUrl": "https://networkcheck.frameos.net",
            "wifiHotspot": "disabled",
            "wifiHotspotSsid": "FrameOS-Setup",
            "wifiHotspotPassword": "frame1234",
            "wifiHotspotTimeoutSeconds": 300,
        },
        "palette": {"colors": []},
        "agent": {"agentEnabled": False},
    }


def write_json(path: Path, payload: Any) -> None:
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def assemble_package(
    *,
    package_dir: Path,
    target_dir: Path,
    components: dict[str, dict[str, Any]],
    width: int,
    height: int,
    upload_url: str,
    upload_token: str,
    scene_mode: str,
    color: str,
) -> dict[str, Any]:
    package_dir.mkdir(parents=True, exist_ok=True)
    for dirname in ("drivers", "scenes", "state", "tmp"):
        (package_dir / dirname).mkdir(parents=True, exist_ok=True)

    runtime_binary = component_file(target_dir, components, "frameos", default_name="frameos")
    packaged_binary = package_dir / "frameos"
    shutil.copy2(runtime_binary, packaged_binary)
    os.chmod(packaged_binary, 0o755)

    http_upload_plugin = component_file(target_dir, components, "driver_httpUpload")
    shutil.copy2(http_upload_plugin, package_dir / "drivers" / http_upload_plugin.name)

    frame_payload = verification_frame_json(
        width=width,
        height=height,
        upload_url=upload_url,
        upload_token=upload_token,
    )
    scene_payload = verification_scene(color=color, execution=scene_mode)
    write_json(package_dir / "frame.json", frame_payload)
    write_json(package_dir / "scenes.json", [] if scene_mode == "compiled" else [scene_payload])
    return scene_payload


@contextlib.contextmanager
def temporary_home(root: Path):
    original_home = os.environ.get("HOME")
    original_nimble = os.environ.get("NIMBLE_DIR")
    home_dir = root / "home"
    nimble_dir = root / ".nimble"
    home_dir.mkdir(parents=True, exist_ok=True)
    nimble_dir.mkdir(parents=True, exist_ok=True)
    os.environ["HOME"] = str(home_dir)
    os.environ["NIMBLE_DIR"] = str(nimble_dir)
    try:
        yield
    finally:
        if original_home is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = original_home
        if original_nimble is None:
            os.environ.pop("NIMBLE_DIR", None)
        else:
            os.environ["NIMBLE_DIR"] = original_nimble


@contextlib.contextmanager
def working_directory(path: Path):
    previous = Path.cwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(previous)


async def build_compiled_scene(
    *,
    work_root: Path,
    target_slug: str,
    target_dir: Path,
    metadata: dict[str, Any],
    components: dict[str, dict[str, Any]],
    scene_payload: dict[str, Any],
) -> Path:
    from app.api import frames as frames_api
    from app.tasks._frame_deployer import FrameDeployer
    from app.tasks.utils import find_nim_v2
    from app.utils.cross_compile import TargetMetadata

    frame = SimpleNamespace(
        id=0,
        device="http.upload",
        mode="web_only",
        scenes=[scene_payload],
        gpio_buttons=[],
        debug=False,
        network={},
        agent={},
        assets_path="",
    )

    class StandaloneFrameDeployer(FrameDeployer):
        async def log(self, type: str, line: str, timestamp=None):  # type: ignore[override]
            print(f"[scene-build][{type}] {line}")

    target = TargetMetadata(
        arch=str(metadata["arch"]),
        distro=str(metadata["distribution"]),
        version=str(metadata["release"]),
        platform=str(metadata.get("platform") or ""),
        image=str(metadata.get("image") or ""),
    )

    deployer = StandaloneFrameDeployer(
        db=None,
        redis=None,
        frame=frame,
        nim_path=find_nim_v2(),
        temp_dir=str(work_root),
    )
    with working_directory(BACKEND_ROOT):
        result = await frames_api._build_packaged_compiled_scenes(
            db=None,
            redis=None,
            frame=frame,
            temp_dir=str(work_root),
            deployer=deployer,
            target=target,
            target_slug=target_slug,
            target_dir=target_dir,
            components=components,
        )
    if result is None:
        raise RuntimeError("Compiled scene build returned no artifacts")
    return result


def start_capture_server(host: str, port: int, capture: UploadCapture) -> tuple[CaptureServer, threading.Thread]:
    server = CaptureServer((host, port), capture)
    thread = threading.Thread(target=server.serve_forever, name="frameos-upload-capture", daemon=True)
    thread.start()
    return server, thread


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def run_command(cmd: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(
        cmd,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if check and completed.returncode != 0:
        rendered = " ".join(cmd)
        raise RuntimeError(
            f"Command failed ({completed.returncode}): {rendered}\n"
            f"stdout:\n{completed.stdout}\n"
            f"stderr:\n{completed.stderr}"
        )
    return completed


def sanitize_docker_tag(value: str) -> str:
    cleaned = []
    for char in value.lower():
        if char.isalnum() or char in "._-":
            cleaned.append(char)
        else:
            cleaned.append("-")
    return "".join(cleaned).strip("-.") or "frameos-prebuilt-e2e"


def docker_image_exists(image: str) -> bool:
    completed = run_command(["docker", "image", "inspect", image], check=False)
    return completed.returncode == 0


def prepare_runtime_image(
    *,
    work_root: Path,
    target_slug: str,
    base_image: str,
    platform: str,
) -> str:
    runtime_image = f"frameos-prebuilt-e2e:{sanitize_docker_tag(target_slug)}"
    if docker_image_exists(runtime_image):
        return runtime_image

    dockerfile = work_root / "Dockerfile.runtime"
    packages_shell = " ".join(DEFAULT_RUNTIME_PACKAGES)
    optional_shell = " ".join(OPTIONAL_RUNTIME_PACKAGES)
    dockerfile.write_text(
        "\n".join(
            [
                f"FROM --platform={platform} {base_image}",
                "RUN set -eux; \\",
                "    apt-get update; \\",
                f"    packages='{packages_shell}'; \\",
                f"    for candidate in {optional_shell}; do \\",
                "      if apt-cache pkgnames | grep -Fx \"$candidate\" >/dev/null 2>&1; then \\",
                "        packages=\"$packages $candidate\"; \\",
                "      fi; \\",
                "    done; \\",
                "    apt-get install -y --no-install-recommends $packages; \\",
                "    rm -rf /var/lib/apt/lists/*",
                "",
            ]
        ),
        encoding="utf-8",
    )

    run_command(
        [
            "docker",
            "build",
            "--platform",
            platform,
            "--tag",
            runtime_image,
            "--file",
            str(dockerfile),
            str(work_root),
        ]
    )
    return runtime_image


def start_container(
    *,
    package_dir: Path,
    image: str,
    platform: str,
) -> str:
    container_name = f"frameos-prebuilt-e2e-{uuid.uuid4().hex[:12]}"
    cmd = [
        "docker",
        "run",
        "--detach",
        "--name",
        container_name,
        "--platform",
        platform,
        "--workdir",
        "/package",
        "--volume",
        f"{package_dir}:/package",
    ]
    if sys.platform.startswith("linux"):
        cmd.extend(["--add-host", "host.docker.internal:host-gateway"])
    cmd.extend(
        [
            image,
            "sh",
            "-lc",
            "chmod +x ./frameos && ./frameos",
        ]
    )
    completed = run_command(cmd)
    container_id = completed.stdout.strip()
    if not container_id:
        raise RuntimeError(f"docker run did not return a container id:\n{completed.stderr}")
    return container_name


def container_running(container_name: str) -> bool:
    completed = run_command(
        ["docker", "inspect", "--format", "{{.State.Running}}", container_name],
        check=False,
    )
    return completed.returncode == 0 and completed.stdout.strip() == "true"


def container_logs(container_name: str) -> str:
    completed = run_command(["docker", "logs", container_name], check=False)
    return (completed.stdout or "") + (completed.stderr or "")


def remove_container(container_name: str) -> None:
    run_command(["docker", "rm", "-f", container_name], check=False)


def wait_for_upload(
    *,
    capture: UploadCapture,
    container_name: str,
    timeout: float,
) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if capture.event.wait(timeout=0.5):
            return
        if not container_running(container_name):
            logs = container_logs(container_name).strip()
            raise RuntimeError(
                "FrameOS container exited before the upload completed.\n"
                + (f"container logs:\n{logs}" if logs else "container produced no logs")
            )
    logs = container_logs(container_name).strip()
    raise RuntimeError(
        f"Timed out waiting {timeout:.1f}s for an upload.\n"
        + (f"container logs:\n{logs}" if logs else "container produced no logs")
    )


def paeth_predictor(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa = abs(p - a)
    pb = abs(p - b)
    pc = abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def decode_png_rgba(data: bytes) -> tuple[int, int, bytes]:
    if not data.startswith(PNG_SIGNATURE):
        raise RuntimeError("Upload was not a PNG")

    cursor = len(PNG_SIGNATURE)
    width = height = -1
    bit_depth = color_type = -1
    idat_chunks: list[bytes] = []

    while cursor < len(data):
        if cursor + 8 > len(data):
            raise RuntimeError("Truncated PNG chunk header")
        chunk_len = struct.unpack(">I", data[cursor : cursor + 4])[0]
        cursor += 4
        chunk_type = data[cursor : cursor + 4]
        cursor += 4
        chunk_data = data[cursor : cursor + chunk_len]
        cursor += chunk_len
        cursor += 4  # CRC

        if chunk_type == b"IHDR":
            width, height, bit_depth, color_type, compression, filtering, interlace = struct.unpack(
                ">IIBBBBB",
                chunk_data,
            )
            if compression != 0 or filtering != 0 or interlace != 0:
                raise RuntimeError("Unsupported PNG compression/filter/interlace settings")
        elif chunk_type == b"IDAT":
            idat_chunks.append(chunk_data)
        elif chunk_type == b"IEND":
            break

    if width <= 0 or height <= 0:
        raise RuntimeError("PNG was missing an IHDR chunk")
    if bit_depth != 8:
        raise RuntimeError(f"Unsupported PNG bit depth: {bit_depth}")
    if color_type == 6:
        bytes_per_pixel = 4
    elif color_type == 2:
        bytes_per_pixel = 3
    else:
        raise RuntimeError(f"Unsupported PNG color type: {color_type}")

    inflated = zlib.decompress(b"".join(idat_chunks))
    row_size = width * bytes_per_pixel
    expected_size = height * (1 + row_size)
    if len(inflated) != expected_size:
        raise RuntimeError(
            f"Unexpected inflated PNG size: got {len(inflated)}, expected {expected_size}",
        )

    result = bytearray(width * height * bytes_per_pixel)
    previous = bytearray(row_size)
    offset = 0
    for row in range(height):
        filter_type = inflated[offset]
        offset += 1
        current = bytearray(inflated[offset : offset + row_size])
        offset += row_size

        if filter_type == 0:
            pass
        elif filter_type == 1:
            for index in range(row_size):
                left = current[index - bytes_per_pixel] if index >= bytes_per_pixel else 0
                current[index] = (current[index] + left) & 0xFF
        elif filter_type == 2:
            for index in range(row_size):
                current[index] = (current[index] + previous[index]) & 0xFF
        elif filter_type == 3:
            for index in range(row_size):
                left = current[index - bytes_per_pixel] if index >= bytes_per_pixel else 0
                up = previous[index]
                current[index] = (current[index] + ((left + up) // 2)) & 0xFF
        elif filter_type == 4:
            for index in range(row_size):
                left = current[index - bytes_per_pixel] if index >= bytes_per_pixel else 0
                up = previous[index]
                up_left = previous[index - bytes_per_pixel] if index >= bytes_per_pixel else 0
                current[index] = (current[index] + paeth_predictor(left, up, up_left)) & 0xFF
        else:
            raise RuntimeError(f"Unsupported PNG row filter: {filter_type}")

        start = row * row_size
        result[start : start + row_size] = current
        previous = current

    if bytes_per_pixel == 3:
        expanded = bytearray(width * height * 4)
        for index in range(width * height):
            source = index * 3
            target = index * 4
            expanded[target : target + 3] = result[source : source + 3]
            expanded[target + 3] = 255
        return width, height, bytes(expanded)

    return width, height, bytes(result)


def verify_upload(
    *,
    capture: UploadCapture,
    width: int,
    height: int,
    color: str,
) -> None:
    if capture.error:
        raise RuntimeError(capture.error)
    if capture.body is None:
        raise RuntimeError("No upload body was captured")
    if capture.content_type != "image/png":
        raise RuntimeError(f"Unexpected Content-Type: {capture.content_type!r}")

    png_width, png_height, rgba = decode_png_rgba(capture.body)
    if png_width != width or png_height != height:
        raise RuntimeError(
            f"Unexpected PNG dimensions: got {png_width}x{png_height}, expected {width}x{height}",
        )

    expected_rgb = rgb_triplet(color)
    for pixel_index in range(0, len(rgba), 4):
        pixel = tuple(rgba[pixel_index : pixel_index + 3])
        if pixel != expected_rgb:
            raise RuntimeError(
                f"Unexpected pixel color at byte offset {pixel_index}: got {pixel}, expected {expected_rgb}",
            )


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    prebuilt_root = Path(args.prebuilt_root).resolve()
    target_dir, metadata, components = read_target_metadata(prebuilt_root, args.target)

    platform = str(metadata.get("platform") or "")
    default_image = ""
    distribution = str(metadata.get("distribution") or metadata.get("distro") or "").strip()
    release = str(metadata.get("release") or metadata.get("version") or "").strip()
    if distribution and release:
        default_image = f"{distribution}:{release}"
    base_image = args.runtime_image or str(metadata.get("image") or default_image)
    if not platform:
        raise RuntimeError(f"Target metadata is missing a platform: {target_dir / 'metadata.json'}")
    if not base_image:
        raise RuntimeError(f"Target metadata is missing an image: {target_dir / 'metadata.json'}")

    upload_port = free_port()
    upload_path = "/upload"
    upload_token = uuid.uuid4().hex
    upload_url = f"http://{args.host_name}:{upload_port}{upload_path}"
    capture = UploadCapture(
        expected_path=upload_path,
        expected_token=upload_token,
        event=threading.Event(),
    )
    server, thread = start_capture_server("0.0.0.0", upload_port, capture)

    temp_context: contextlib.AbstractContextManager[str]
    if args.keep_temp:
        root_path = Path(tempfile.mkdtemp(prefix="frameos-prebuilt-e2e-"))

        @contextlib.contextmanager
        def keep_dir() -> Any:
            yield str(root_path)

        temp_context = keep_dir()
    else:
        temp_context = tempfile.TemporaryDirectory(prefix="frameos-prebuilt-e2e-")

    container_name = ""
    try:
        with temp_context as root:
            work_root = Path(root).resolve()
            package_dir = work_root / "package"
            scene_payload = assemble_package(
                package_dir=package_dir,
                target_dir=target_dir,
                components=components,
                width=args.width,
                height=args.height,
                upload_url=upload_url,
                upload_token=upload_token,
                scene_mode=args.scene_mode,
                color=args.color,
            )

            if args.scene_mode == "compiled":
                with temporary_home(work_root):
                    compiled_dir = asyncio.run(
                        build_compiled_scene(
                            work_root=work_root,
                            target_slug=args.target,
                            target_dir=target_dir,
                            metadata=metadata,
                            components=components,
                            scene_payload=scene_payload,
                        )
                    )
                compiled_libraries = sorted(compiled_dir.glob("*.so"))
                if not compiled_libraries:
                    raise RuntimeError(f"Compiled scene build produced no .so files in {compiled_dir}")
                for library in compiled_libraries:
                    shutil.copy2(library, package_dir / "scenes" / library.name)

            runtime_image = prepare_runtime_image(
                work_root=work_root,
                target_slug=args.target,
                base_image=base_image,
                platform=platform,
            )

            container_name = start_container(
                package_dir=package_dir,
                image=runtime_image,
                platform=platform,
            )
            wait_for_upload(
                capture=capture,
                container_name=container_name,
                timeout=args.timeout,
            )
            verify_upload(
                capture=capture,
                width=args.width,
                height=args.height,
                color=args.color,
            )

            print(f"Verified target {args.target} via {args.scene_mode} scene")
            print(f"Runtime image: {runtime_image} (base {base_image}, {platform})")
            print(f"Package dir: {package_dir}")
            print(f"Upload url: {upload_url}")
            print(f"Captured PNG: {args.width}x{args.height} solid {args.color}")
            if args.keep_temp:
                print(f"Kept workdir: {work_root}")
            return 0
    finally:
        if container_name:
            logs = container_logs(container_name).strip()
            if logs:
                print("Container logs:")
                print(logs)
            remove_container(container_name)
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
