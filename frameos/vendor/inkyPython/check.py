import sys
import argparse
from devices.util import log, init_inky, get_int_tuple

if __name__ == "__main__":
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--device", default="")
    args, _ = parser.parse_known_args()

    inky = init_inky(args.device)
    if not inky:
        sys.exit(1)

    resolution = getattr(inky, "resolution", (getattr(inky, "width", 0), getattr(inky, "height", 0)))
    width, height = get_int_tuple(resolution)
    colour = getattr(inky, "colour", getattr(inky, "color", None))
    eeprom = getattr(inky, "eeprom", None)

    log({
        "inky": True,
        "width": width,
        "height": height,
        "color": colour,
        "model": getattr(eeprom, "get_variant", lambda: None)() if eeprom else None,
        "variant": getattr(eeprom, "display_variant", None) if eeprom else None,
        "pcb": getattr(eeprom, "pcb_variant", None) if eeprom else None,
    })
    sys.exit(0)
