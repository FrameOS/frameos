# devices/util.py
import sys
import json
import traceback
from typing import Optional, Tuple, Any

def log(obj: dict):
    print(json.dumps(obj))
    sys.stdout.flush()

def init_inky(device: str = "") -> Optional[Any]:
    """
    Returns an Inky instance either from local device files (if mapped)
    or by falling back to auto-detection.
    """
    try:
        if device == "pimoroni.inky_impression_7":
            from inky.inky_e673 import Inky
            return Inky(resolution=(800, 480))
        elif device == "pimoroni.inky_impression_13":
            from inky.inky_el133uf1 import Inky
            return Inky(resolution=(1600, 1200))
        else:
            from inky.auto import auto
            return auto()
    except ImportError:
        log({ "error": "inky python module not installed" })
    except Exception as e:
        log({ "error": str(e), "stack": traceback.format_exc() })
    sys.stdout.flush()
    return None

def get_int_tuple(value, default: Tuple[int, int] = (0, 0)) -> Tuple[int, int]:
    try:
        w, h = value
        return int(w), int(h)
    except Exception:
        return default
