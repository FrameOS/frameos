import json
import os
import sys
import requests
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from PIL import Image, ImageChops, ImageStat
import subprocess
import signal
import socket
import threading

DEFAULT_DIFF_THRESHOLD = float(os.environ.get("SNAPSHOT_DIFF_THRESHOLD", "0.01"))
RESAMPLE_FILTER = getattr(Image, "Resampling", Image).LANCZOS
UPLOAD_TIMEOUT_SECONDS = float(os.environ.get("FRAMEOS_E2E_UPLOAD_TIMEOUT", "10"))
FRAMEOS_PROCESS_LOG = Path(os.environ.get("FRAMEOS_E2E_PROCESS_LOG", "./tmp/frameos-process.log"))
FIXTURE_PORT = int(os.environ.get("FRAMEOS_E2E_FIXTURE_PORT", "0"))
FRAME_PORT = int(os.environ.get("FRAMEOS_E2E_FRAME_PORT", "8787"))

def fixture_response(path):
    if path == "/fixtures/logo_in_ci_tests.png":
        return "image/png", Path("./assets/image.png").read_bytes()
    if path == "/fixtures/ci_text_file":
        return "text/plain; charset=utf-8", b"FrameOS CI text fixture\n"
    return None

def apply_shard(files):
    shard = os.environ.get("FRAMEOS_E2E_SHARD")
    shard_count = os.environ.get("FRAMEOS_E2E_SHARDS")

    if not shard and not shard_count:
        return files

    if not shard or not shard_count:
        raise ValueError("FRAMEOS_E2E_SHARD and FRAMEOS_E2E_SHARDS must be set together")

    shard = int(shard)
    shard_count = int(shard_count)
    if shard_count < 1:
        raise ValueError("FRAMEOS_E2E_SHARDS must be at least 1")
    if shard < 1 or shard > shard_count:
        raise ValueError("FRAMEOS_E2E_SHARD must be between 1 and FRAMEOS_E2E_SHARDS")

    selected = [
        file_path
        for index, file_path in enumerate(files)
        if index % shard_count == shard - 1
    ]
    print(f"Running e2e snapshot shard {shard}/{shard_count}: {len(selected)} of {len(files)} scenes")
    return selected

def compare_images(img_path1, img_path2, threshold=DEFAULT_DIFF_THRESHOLD):
    """Return similarity information between two images.

    The function computes the mean absolute pixel difference normalised to the
    range [0, 1] and considers the images similar when the mean is less than or
    equal to ``threshold``. The maximum pixel delta is reported for additional
    insight.
    """

    with Image.open(img_path1).convert("RGBA") as img1, Image.open(img_path2).convert("RGBA") as img2:
        if img1.size != img2.size:
            img2 = img2.resize(img1.size, RESAMPLE_FILTER)

        diff = ImageChops.difference(img1, img2)
        stat = ImageStat.Stat(diff)

    mean_diff = sum(stat.mean) / len(stat.mean)
    max_diff = max(channel_max for _, channel_max in stat.extrema)

    normalised_mean = mean_diff / 255.0
    normalised_max = max_diff / 255.0

    return {
        "similar": normalised_mean <= threshold,
        "mean_diff": normalised_mean,
        "max_diff": normalised_max,
    }

def is_similar_image(img_path1, img_path2, threshold=DEFAULT_DIFF_THRESHOLD):
    result = compare_images(img_path1, img_path2, threshold)
    return result["similar"]

class UploadReceiver:
    def __init__(self):
        self.condition = threading.Condition()
        self.uploads = []
        self.server = None
        self.thread = None

    def start(self, port=0):
        receiver = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self):
                try:
                    content_length = int(self.headers.get("Content-Length", "0"))
                except ValueError:
                    content_length = 0
                body = self.rfile.read(content_length) if content_length > 0 else b""
                receiver.record_upload(self.path, self.headers, body)
                self.send_response(204)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def do_GET(self):
                response = fixture_response(self.path)
                if response is None:
                    self.send_response(404)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return

                content_type, body = response
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, format, *args):
                return

        self.server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return self.server.server_address[1]

    def stop(self):
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()
        if self.thread is not None:
            self.thread.join(timeout=2)

    def record_upload(self, path, headers, body):
        upload = {
            "path": path,
            "headers": {name: value for name, value in headers.items()},
            "body": body,
            "received_at": time.time(),
        }
        with self.condition:
            self.uploads.append(upload)
            self.condition.notify_all()

    def clear(self):
        with self.condition:
            self.uploads.clear()

    def wait_for_upload(self, timeout=UPLOAD_TIMEOUT_SECONDS):
        deadline = time.monotonic() + timeout
        with self.condition:
            while not self.uploads:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError(f"Timed out waiting for HTTP upload after {timeout:.1f}s")
                self.condition.wait(remaining)
            return self.uploads.pop(0)

def snapshot_reset_scene(scene_id):
    base_scene_id = scene_id.removesuffix("_interpreted")
    return "black" if base_scene_id == "blue" else "blue"

def write_runtime_frame_config(upload_url):
    frame_json = Path("./frame.json")
    contents = json.loads(frame_json.read_text())
    contents["bindHost"] = "127.0.0.1"
    contents["framePort"] = FRAME_PORT
    contents["device"] = "http.upload"
    device_config = dict(contents.get("deviceConfig") or {})
    device_config["uploadUrl"] = upload_url
    headers = list(device_config.get("uploadHeaders") or [])
    headers.extend([
        {"name": "X-FrameOS-E2E-Snapshot", "value": "1"},
        {"name": "X-FrameOS-E2E-Run-Id", "value": uuid.uuid4().hex},
    ])
    device_config["uploadHeaders"] = headers
    contents["deviceConfig"] = device_config

    runtime_config_path = Path("./tmp/frame.snapshot.json")
    runtime_config_path.parent.mkdir(exist_ok=True)
    runtime_config_path.write_text(json.dumps(contents, indent=4) + "\n")
    return runtime_config_path

def set_scene(port, scene_id):
    response = requests.post(
        f"http://localhost:{port}/event/setCurrentScene",
        json={"sceneId": scene_id},
        timeout=5,
    )
    if response.status_code != 200:
        raise RuntimeError(f"Failed to set scene {scene_id}: HTTP {response.status_code}")

def tail_file(path, max_lines=80):
    if not path.exists():
        return ""
    lines = path.read_text(errors="replace").splitlines()
    return "\n".join(lines[-max_lines:])

def ensure_frameos_running(process):
    returncode = process.poll()
    if returncode is None:
        return

    log_tail = tail_file(FRAMEOS_PROCESS_LOG)
    message = f"frameos exited unexpectedly (exit code {returncode})"
    if log_tail:
        message += f"\nLast frameos log lines:\n{log_tail}"
    raise RuntimeError(message)

def set_scene_and_wait_for_upload(port, receiver, scene_id):
    receiver.clear()
    set_scene(port, scene_id)
    upload = receiver.wait_for_upload()
    if not upload["body"]:
        raise RuntimeError(f"Received empty HTTP upload for scene {scene_id}")
    return upload

def wait_for_frameos_server(process, port, timeout=15):
    deadline = time.monotonic() + timeout
    last_error = None
    while time.monotonic() < deadline:
        returncode = process.poll()
        if returncode is not None:
            log_tail = tail_file(FRAMEOS_PROCESS_LOG)
            message = f"frameos exited before the HTTP server was ready (exit code {returncode})"
            if log_tail:
                message += f"\nLast frameos log lines:\n{log_tail}"
            raise RuntimeError(message)
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return
        except OSError as error:
            last_error = error
            time.sleep(0.1)
    raise TimeoutError(f"Timed out waiting for frameos HTTP server on 127.0.0.1:{port}: {last_error}")

def main():
    # filter from env or argv (argv optional)
    filter_str = os.environ.get("SCENE_FILTER") or (sys.argv[1] if len(sys.argv) > 1 else "")
    filter_str = filter_str.strip().lower()
    receiver = UploadReceiver()
    upload_port = receiver.start(FIXTURE_PORT)
    upload_url = f"http://127.0.0.1:{upload_port}/upload"
    runtime_config_path = write_runtime_frame_config(upload_url)
    env = os.environ.copy()
    env["FRAMEOS_SCENES_JSON"] = Path('./tmp/scenes.json').resolve().as_posix()
    env["FRAMEOS_CONFIG"] = runtime_config_path.resolve().as_posix()
    print(f"Listening for FrameOS HTTP uploads on {upload_url}")
    # Start the frameos binary in the background
    FRAMEOS_PROCESS_LOG.parent.mkdir(exist_ok=True)
    process_log_file = FRAMEOS_PROCESS_LOG.open("w")
    process = subprocess.Popen(
        ['./tmp/frameos-bin', '--debug'],
        env=env,
        stdout=process_log_file,
        stderr=subprocess.STDOUT,
    )
    print(f"Started frameos with PID {process.pid}")
    print(f"FrameOS process output: {FRAMEOS_PROCESS_LOG}")

    try:
        time.sleep(2)

        contents = json.loads(runtime_config_path.read_text())
        port = contents.get('framePort', 8787)
        wait_for_frameos_server(process, port)

        scenes_dir = Path('./scenes')
        snapshots_dir = Path('./snapshots')
        snapshots_dir.mkdir(exist_ok=True)
        failures = 0

        files = sorted(scenes_dir.glob('*.json'))
        if filter_str:
            files = [p for p in files if filter_str in p.stem.lower()]
        files = apply_shard(files)

        if not files:
            print(f"No scenes matched filter: '{filter_str}'" if filter_str else "No scenes found.")
            return

        for scene_file in files:
            base_id = scene_file.stem
            for (scene_id, filename) in [
                (base_id, base_id + '_compiled'), 
                (base_id + '_interpreted', base_id + '_interpreted')
            ]:
                print(f"🍿 Processing scene: {scene_id}")
                ensure_frameos_running(process)

                reset_scene_id = snapshot_reset_scene(scene_id)
                try:
                    receiver.clear()
                    set_scene(port, reset_scene_id)
                    try:
                        receiver.wait_for_upload(timeout=2)
                    except TimeoutError:
                        pass
                    upload = set_scene_and_wait_for_upload(port, receiver, scene_id)
                except (requests.RequestException, RuntimeError, TimeoutError) as error:
                    ensure_frameos_running(process)
                    print(f"Failed to capture snapshot for scene {scene_id}: {error}")
                    failures += 1
                    continue

                snapshot_path = snapshots_dir / f"{filename}.png"
                snapshot_path.write_bytes(upload["body"])
                headers = upload["headers"]
                image_hash = headers.get("X-FrameOS-Image-Hash", "unknown")
                image_size = headers.get("X-FrameOS-Image-Bytes", str(len(upload["body"])))
                print(f"Snapshot captured from HTTP upload: {snapshot_path} ({image_size} bytes, hash {image_hash})")
            # compare files: base_id + '_compiled' and base_id + '_interpreted'
            compiled_path = snapshots_dir / f"{base_id}_compiled.png"
            interpreted_path = snapshots_dir / f"{base_id}_interpreted.png"
            if compiled_path.exists() and interpreted_path.exists():
                if is_similar_image(compiled_path, interpreted_path):
                    print(f"✅ Snapshots are similar for scene {base_id}")
                    # rename to base_id.png
                    final_path = snapshots_dir / f"{base_id}.png"
                    interpreted_path.unlink()
                    if final_path.exists():
                        if is_similar_image(final_path, compiled_path):
                            compiled_path.unlink()
                        else:
                            final_path.unlink()
                            compiled_path.rename(final_path)
                    else:
                        compiled_path.rename(final_path)
                else:
                    print(f"❌ Snapshots differ for scene {base_id}")
                    failures += 1
                    final_path = snapshots_dir / f"{base_id}.png"
                    final_path.unlink(missing_ok=True)
            else:
                print(f"❌ Missing snapshots for scene {base_id}")
                failures += 1

        if failures:
            raise SystemExit(f"{failures} snapshot failure(s)")
    finally:
        time.sleep(2)
        if process.poll() is None:
            os.kill(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        process_log_file.close()
        receiver.stop()
        print(f"frameos process with PID {process.pid} has been terminated")

if __name__ == "__main__":
    main()
