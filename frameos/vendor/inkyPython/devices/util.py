# devices/util.py
import sys
import json
import traceback
import importlib.util
from pathlib import Path
from typing import Optional, Tuple, Any

def log(obj: dict):
    print(json.dumps(obj))
    sys.stdout.flush()

# Map your device ids to their local driver files
DEVICE_MAP = {
    "pimoroni.inky_impression_7": "inky_e673.py",
    "pimoroni.inky_impression_13": "inky_el133uf1.py",
}

def _load_inky_from_file(file_path: Path, class_name: str = "Inky"):
    try:
        spec = importlib.util.spec_from_file_location(class_name, str(file_path))
        if spec is None or spec.loader is None:
            raise ImportError(f"Cannot load module from {file_path}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)  # type: ignore[attr-defined]
        cls = getattr(module, class_name)
        return cls()
    except Exception as e:
        log({ "error": f"failed loading {class_name} from {file_path.name}: {e}", "stack": traceback.format_exc() })

def init_inky(device: str = "") -> Optional[Any]:
    """
    Returns an Inky instance either from local device files (if mapped)
    or by falling back to auto-detection.
    """
    try:
        if device:
            base = Path(__file__).resolve().parent
            if device in DEVICE_MAP:
                driver_file = base / DEVICE_MAP[device]
                inky = _load_inky_from_file(driver_file, "Inky")
                if inky:
                    return inky

        # Fallback to auto-detect
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
