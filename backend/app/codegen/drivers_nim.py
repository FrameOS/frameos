import json

from app.drivers.drivers import Driver


def _default_library_path(driver: Driver) -> str:
    if driver.name == "waveshare" and driver.variant:
        return f"drivers/waveshare/lib{driver.name}_{driver.variant}.so"
    return f"drivers/lib{driver.name}.so"


def write_drivers_nim(drivers: dict[str, Driver]) -> str:
    manifest: dict[str, list[dict]] = {"drivers": []}

    for driver in drivers.values():
        if not driver.import_path:
            continue

        entry: dict[str, object] = {
            "name": driver.name,
            "library": _default_library_path(driver),
            "capabilities": [],
        }

        capabilities: list[str] = entry["capabilities"]  # type: ignore[assignment]
        if driver.can_render:
            capabilities.append("render")
        if driver.can_png:
            capabilities.append("png")
        if driver.can_turn_on_off:
            capabilities.append("turnOn")
            capabilities.append("turnOff")

        if driver.variant:
            entry["config"] = {"variant": driver.variant}

        manifest["drivers"].append(entry)

    return json.dumps(manifest, indent=2, sort_keys=True)
