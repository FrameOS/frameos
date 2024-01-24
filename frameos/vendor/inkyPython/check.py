import sys
import json

def log(obj: dict):
    print(json.dumps(obj))
    sys.stdout.flush()

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
    sys.exit(0)
