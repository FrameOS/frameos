import sys
import io
import argparse
import inspect
import traceback
import json
import numpy
from devices.util import log, init_inky, get_int_tuple

def read_binary_data():
    binary_data = bytearray()
    while True:
        chunk = sys.stdin.buffer.read(1024)
        if not chunk:
            break
        binary_data.extend(chunk)
    return binary_data

def parse_palette(palette_str):
    """
    Expect a JSON array of 6 RGB triplets, e.g.:
    [[0,0,0],[255,255,255],[255,255,0],[255,0,0],[0,0,255],[0,255,0]]
    Returns list[list[int,int,int]] or None.
    """
    try:
        pal = json.loads(palette_str)
        if (
            isinstance(pal, list) and len(pal) == 6 and
            all(isinstance(c, list) and len(c) == 3 and all(isinstance(x, int) for x in c) for c in pal)
        ):
            # clamp just in case
            return [[max(0, min(255, x)) for x in c] for c in pal]
    except Exception:
        pass
    return None

if __name__ == "__main__":
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--device", default="")
    parser.add_argument("--raw", action="store_true")
    args, _ = parser.parse_known_args()

    inky = init_inky(args.device)
    if not inky:
        sys.exit(1)

    resolution = getattr(inky, "resolution", (getattr(inky, "width", 0), getattr(inky, "height", 0)))
    width, height = get_int_tuple(resolution)
    colour = getattr(inky, "colour", getattr(inky, "color", None))
    log({ "inky": True, "width": width, "height": height, "color": colour })

    data = read_binary_data()
    log({ "bytesReceived": len(data), "format": "dithered" if args.raw else "rgb", "message": "rendering on eink display" })

    if args.raw:
        try:
            expected = (width * height + 1) // 2
            if len(data) != expected:
                log({ "error": f"expected {expected} bytes, got {len(data)}" })
                sys.exit(1)
            arr = numpy.frombuffer(data, dtype=numpy.uint8)
            buf = numpy.empty(width * height, dtype=numpy.uint8)
            buf[0::2] = arr >> 4
            buf[1::2] = arr & 0x0F
            inky.buf = buf.reshape((height, width))
            show = getattr(inky, "show", None)
            if not callable(show):
                log({ "error": "inky.show() not available on this driver" })
                sys.exit(1)
            show()
        except Exception as e:
            log({ "error": str(e), "stack": traceback.format_exc() })
            sys.exit(1)
    else:
        try:
            from PIL import Image
        except ImportError:
            log({ "error": "PIL python module not installed" })
            sys.exit(1)

        try:
            image = Image.open(io.BytesIO(data))

            set_image = getattr(inky, "set_image", None)
            if not callable(set_image):
                log({ "error": "inky.set_image() not available on this driver" })
                sys.exit(1)

            # Try to match the signature len (1 or 2 params); fall back gracefully.
            try:
                signature = inspect.signature(set_image)
                if len(signature.parameters) == 2:
                    set_image(image, saturation=1)
                elif len(signature.parameters) == 1:
                    set_image(image)
                else:
                    log({ "error": f"inky.set_image() expects {len(signature.parameters)} params; only 1 or 2 supported" })
                    sys.exit(1)
            except (ValueError, TypeError):
                try:
                    set_image(image, saturation=1)
                except TypeError:
                    set_image(image)

            show = getattr(inky, "show", None)
            if not callable(show):
                log({ "error": "inky.show() not available on this driver" })
                sys.exit(1)
            show()
        except Exception as e:
            log({ "error": str(e), "stack": traceback.format_exc() })
            sys.exit(1)

    sys.exit(0)
