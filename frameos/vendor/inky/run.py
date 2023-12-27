import sys
import json
import io

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
        print(json.dumps({ "error": "inky python module not installed" }))
    except Exception as e:
        print(json.dumps({ "error": str(e) }))
    sys.exit(1)

if __name__ == "__main__":
    inky = init()
    print(json.dumps({ "inky": True, "width": inky.resolution[0], "height": inky.resolution[1], "color": inky.colour }))
    data = read_binary_data()
    print(json.dumps({ "bytesReceived": len(data) }))
    
    try:
        from PIL import Image
    except ImportError:
        print(json.dumps({ "error": "PIL python module not installed" }))
        sys.exit(1)
            
    try:
        image = Image.open(io.BytesIO(data))
        inky.set_image(image, saturation=1)
        inky.show()
    except Exception as e:
        print(json.dumps({ "error": str(e) }))
        sys.exit(1)

    sys.exit(0)
