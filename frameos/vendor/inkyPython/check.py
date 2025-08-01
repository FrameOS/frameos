import sys
import json
import traceback

def log(obj: dict):
    print(json.dumps(obj))
    sys.stdout.flush()

def init():
    try:
        # TODO: we need i2c just for the auto switch. fix it for the nimos version or just ask the board beforehand
        from inky.auto import auto
        inky = auto()
        return inky
    except ImportError:
        log({ "error": "inky python module not installed" })
    except Exception as e:
        log({ "error": str(e), "stack": traceback.format_exc() })
    sys.stdout.flush()

if __name__ == "__main__":
    inky = init()
    log({
        "inky": True,
        "width": inky.resolution[0],
        "height": inky.resolution[1],
        "color": inky.colour,
        "model": inky.eeprom.get_variant() if inky.eeprom else None,
        "variant": inky.eeprom.display_variant if inky.eeprom else None,
        "pcb": inky.eeprom.pcb_variant if inky.eeprom else None,
    })
    sys.exit(0)
