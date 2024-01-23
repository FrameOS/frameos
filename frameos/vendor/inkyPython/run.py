import sys
import json
import io
import inspect

def log(obj: dict):
    print(json.dumps(obj))
    sys.stdout.flush()

def read_binary_data():
    binary_data = bytearray()
    while True:
        chunk = sys.stdin.buffer.read(1024)
        if not chunk:
            break
        binary_data.extend(chunk)
    return binary_data

def init():
    try:
        from inky.auto import auto
        inky = auto()
        return inky
    except ImportError:
        log({ "error": "inky python module not installed" })
    except Exception as e:
        log({ "error": str(e) })
    sys.stdout.flush()

if __name__ == "__main__":
    inky = init()
    log({ "inky": True, "width": inky.resolution[0], "height": inky.resolution[1], "color": inky.colour })
    data = read_binary_data()
    log({ "bytesReceived": len(data) })

    try:
        from PIL import Image
    except ImportError:
        log({ "error": "PIL python module not installed" })
        sys.exit(1)

    try:
        image = Image.open(io.BytesIO(data))
        signature = inspect.signature(inky.set_image)
        num_parameters = len(signature.parameters)
        if num_parameters == 2:
            # TODO: make the saturation variable configurable when setting up the frame
            inky.set_image(image, saturation=1)
        elif num_parameters == 1:
            inky.set_image(image)
        else:
            log({ "error": f"inky.set_image() requires {num_parameters} arguments, but we only support sending 1 or 2" })
            sys.exit(1)

        inky.show()
    except Exception as e:
        log({ "error": str(e) })
        sys.exit(1)

    sys.exit(0)
