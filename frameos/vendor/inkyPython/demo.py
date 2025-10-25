import argparse
import colorsys
import io
import json
import subprocess
import sys
import traceback
from pathlib import Path
from typing import Tuple

import numpy

from devices.util import log

DEFAULT_RESOLUTION: Tuple[int, int] = (600, 448)


def generate_rainbow_image(width: int, height: int):
    hues = numpy.linspace(0.0, 1.0, num=max(width, 1), endpoint=False)
    colours = numpy.array([colorsys.hsv_to_rgb(hue, 1.0, 1.0) for hue in hues], dtype=numpy.float32)
    colours = (colours * 255).astype(numpy.uint8)

    image_array = numpy.tile(colours, (max(height, 1), 1, 1)).astype(numpy.float32)
    brightness = numpy.linspace(0.6, 1.0, num=max(height, 1), endpoint=True, dtype=numpy.float32)
    image_array *= brightness.reshape((max(height, 1), 1, 1))
    image_array = numpy.clip(image_array, 0, 255).astype(numpy.uint8)

    from PIL import Image

    return Image.fromarray(image_array, mode="RGB")


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--device", default="")
    args, passthrough = parser.parse_known_args()

    run_path = Path(__file__).with_name("run.py")
    command = [sys.executable, str(run_path)]
    if args.device:
        command.extend(["--device", args.device])
    command.extend(passthrough)

    log({
        "message": "starting inkyPython run.py demo",
        "device": args.device or None,
        "command": command,
    })

    try:
        process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=str(run_path.parent),
        )
    except Exception as exc:
        log({"error": f"failed to launch run.py: {exc}"})
        sys.exit(1)

    width, height = 0, 0
    colour = None

    try:
        while True:
            line = process.stdout.readline()
            if not line:
                break
            sys.stdout.buffer.write(line)
            sys.stdout.flush()

            decoded = line.decode("utf-8", errors="replace").strip()
            if not decoded:
                continue

            try:
                payload = json.loads(decoded)
            except json.JSONDecodeError:
                continue

            if payload.get("inky"):
                width = int(payload.get("width") or 0) or width
                height = int(payload.get("height") or 0) or height
                colour = payload.get("color") or payload.get("colour")
                break

        if process.poll() is not None:
            remaining_stdout = process.stdout.read()
            if remaining_stdout:
                sys.stdout.buffer.write(remaining_stdout)
                sys.stdout.flush()

            stderr_bytes = process.stderr.read()
            if stderr_bytes:
                sys.stderr.buffer.write(stderr_bytes)
                sys.stderr.flush()

            return_code = process.wait()
            log({"error": "run.py exited before demo image was sent", "status": return_code})
            sys.exit(return_code or 1)

        image_width, image_height = width, height
        if image_width <= 0 or image_height <= 0:
            image_width, image_height = DEFAULT_RESOLUTION
            log({
                "message": "using fallback resolution for demo image",
                "requestedWidth": width,
                "requestedHeight": height,
                "renderWidth": image_width,
                "renderHeight": image_height,
            })

        log({
            "message": "sending rainbow demo image to run.py",
            "width": image_width,
            "height": image_height,
            "color": colour,
        })

        image = generate_rainbow_image(image_width, image_height)
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        png_bytes = buffer.getvalue()

        if not process.stdin:
            raise RuntimeError("run.py stdin is not available")

        process.stdin.write(png_bytes)
        process.stdin.flush()
        process.stdin.close()

        remaining_stdout = process.stdout.read()
        if remaining_stdout:
            sys.stdout.buffer.write(remaining_stdout)
            sys.stdout.flush()

        stderr_bytes = process.stderr.read()
        if stderr_bytes:
            sys.stderr.buffer.write(stderr_bytes)
            sys.stderr.flush()

        return_code = process.wait()
        if return_code != 0:
            log({"error": f"run.py exited with status {return_code}"})
            sys.exit(return_code)

    except ImportError:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
        log({"error": "PIL python module not installed"})
        sys.exit(1)
    except Exception as exc:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
        log({"error": str(exc), "stack": traceback.format_exc()})
        sys.exit(1)

    sys.exit(0)


if __name__ == "__main__":
    main()
