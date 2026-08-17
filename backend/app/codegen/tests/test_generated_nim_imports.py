"""Every Nim symbol the codegen emits must come from a module it imports.

This exists because of a release that failed on every cross target at once.
`write_release_shared_drivers_nim` grew a call to `requestEarlierRender` and
not the `import frameos/driver_render_hint` that defines it. Nothing caught it:
the host binary compiles from checked-in sources, the sibling generator in
drivers_nim.py *did* get the import, and the release drivers module is only
ever compiled by the cross build — so the first thing to notice was twelve
red matrix legs.

The check is deliberately dumb: a table of symbol -> defining module, applied
to every source the driver codegen can produce. It cannot prove a generated
file compiles; it does prove that a symbol added to one generator's output
brought its import along, which is the whole failure mode.
"""

from __future__ import annotations

import re

import pytest

from app.codegen.drivers_nim import (
    write_driver_library_nim,
    write_drivers_nim,
    COMPILATION_MODE_PRECOMPILED,
    COMPILATION_MODE_STATIC,
)
from app.codegen.release_drivers_nim import (
    release_driver_specs,
    write_release_shared_drivers_nim,
)
from app.drivers.drivers import DRIVERS

# Symbol -> the module that defines it. Only symbols the generators actually
# emit; add a row when the codegen starts calling something new.
SYMBOL_MODULES = {
    "requestEarlierRender": "frameos/driver_render_hint",
    "takeEarlierRenderRequest": "frameos/driver_render_hint",
    "nextRenderSeconds": "frameos/driver_render_hint",
    "DriverEarlierRenderProc": "frameos/driver_abi",
    "DriverRenderProc": "frameos/driver_abi",
    "HostLogProc": "frameos/driver_abi",
    "HostSendEventProc": "frameos/driver_abi",
    "setSharedHostCallbacks": "frameos/channels",
    "DriverContext": "frameos/driver_context",
    "setupLog": "frameos/device_setup",
}


def imported_modules(source: str) -> set[str]:
    modules: set[str] = set()
    for line in source.splitlines():
        match = re.match(r"^\s*import\s+([A-Za-z0-9_/]+)", line)
        if match:
            modules.add(match.group(1))
    return modules


def assert_symbols_are_imported(source: str, label: str) -> None:
    imports = imported_modules(source)
    # `import frameos/channels as hostChannels` still imports the module; the
    # regex above keeps the path, which is what the table is keyed on.
    missing = sorted(
        f"{symbol} (needs {module})"
        for symbol, module in SYMBOL_MODULES.items()
        if re.search(rf"\b{re.escape(symbol)}\b", source) and module not in imports
    )
    assert not missing, (
        f"{label} uses symbols it does not import: {', '.join(missing)}. "
        "Generated driver modules are only compiled by the cross build, so a "
        "missing import here fails the release and nothing before it."
    )


def all_release_drivers():
    return release_driver_specs()


def test_release_shared_drivers_module_imports_what_it_uses():
    source = write_release_shared_drivers_nim(all_release_drivers())
    assert_symbols_are_imported(source, "release shared drivers.nim")


@pytest.mark.parametrize(
    "mode", [COMPILATION_MODE_STATIC, COMPILATION_MODE_PRECOMPILED]
)
def test_per_frame_drivers_module_imports_what_it_uses(mode):
    drivers = {name: DRIVERS[name] for name in ("frameBuffer", "inky", "waveshare")}
    source = write_drivers_nim(drivers, mode)
    assert_symbols_are_imported(source, f"drivers.nim ({mode})")


def test_every_driver_library_imports_what_it_uses():
    for name, driver in all_release_drivers().items():
        if not driver.import_path:
            continue
        source = write_driver_library_nim(driver)
        assert_symbols_are_imported(source, f"driver library {name}")


def test_the_check_would_have_caught_the_release_that_failed():
    # The exact regression: the call present, the import absent.
    broken = "import frameos/driver_abi\n\nproc x() =\n  requestEarlierRender(1.0)\n"
    with pytest.raises(AssertionError, match="requestEarlierRender"):
        assert_symbols_are_imported(broken, "deliberately broken")
    fixed = "import frameos/driver_render_hint\n" + broken
    assert_symbols_are_imported(fixed, "fixed")


def test_both_host_generators_agree_on_their_frameos_imports():
    # The two host-side generators emit near-identical modules; when one grows
    # an import the other almost always needs it too, and the drift is exactly
    # what shipped the broken release.
    release = imported_modules(write_release_shared_drivers_nim(all_release_drivers()))
    drivers = {name: DRIVERS[name] for name in ("frameBuffer", "inky", "waveshare")}
    shared = imported_modules(
        write_drivers_nim(drivers, COMPILATION_MODE_PRECOMPILED)
    )
    frameos_release = {m for m in release if m.startswith("frameos/")}
    frameos_shared = {m for m in shared if m.startswith("frameos/")}
    assert frameos_shared <= frameos_release, (
        "the per-frame precompiled generator imports frameos modules the "
        f"release generator does not: {sorted(frameos_shared - frameos_release)}"
    )
