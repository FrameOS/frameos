"""The driver `.so` ABI rule, as a lint over the driver sources.

The rule and its reasoning live at the top of
`frameos/src/frameos/driver_abi.nim`: every shared library carries its own ORC
runtime, so a ref allocated by one side and incref'd/decref'd by the other
crashes the HOST inside `unregisterCycle` as soon as ORC considers the type
cyclic. That is what turned v2026.8.17-.23 into a crash loop on every
HDMI/HyperPixel/Inky frame.

The boundary itself is fixed — log and event payloads cross as `cstring` JSON,
the driver context is bound `{.cursor.}` and its types are `{.acyclic.}` — but
the drivers were audited by hand for the first time on 2026-08-16, and a hand
audit only holds until the next driver. What a violation looks like:

  * a driver storing the `Image` it is handed in a field or a global, or
  * keeping any part of the `DriverContext` the host allocated past the call
    that gave it.

The audit found none: every driver keeps value copies (`seq[uint8]`,
`seq[ColorRGBX]`, a hash) and never the `Image` ref; `inky.imageForPanel`
returns `nil` rather than the host's image; `frameBuffer.render` reads the
host's pixels through a raw view and opens the device before touching the
image at all. The context refs a driver does hold (`DriverLogger`,
`PaletteConfig`) are the per-library clone `cloneDriverContext` makes, not the
host's originals.

This test is the part of that audit that keeps holding. It is deliberately
textual: it cannot prove absence of the hazard, it just refuses the two shapes
that produced it.
"""

from __future__ import annotations

import re
from pathlib import Path

DRIVERS_DIR = Path(__file__).resolve().parents[4] / "frameos" / "src" / "drivers"

# `field*: Image`, `field: Image`, `field*: DriverContext`, and the seq/Option
# wrappers around them. Value types that merely mention the name (ScreenInfo,
# lastImageBytes) do not match — the type, not the field name, is what counts.
FORBIDDEN_FIELD = re.compile(
    r"^\s{2,}\w+\*?\s*:\s*(seq\[|Option\[)?(Image|DriverContext)\]?\s*(#.*)?$"
)
# A module-level `var lastImage: Image` outlives every call by construction.
FORBIDDEN_GLOBAL = re.compile(
    r"^var\s+\w+\*?\s*:\s*(seq\[|Option\[)?(Image|DriverContext)\]?\b"
)


def driver_sources() -> list[Path]:
    return sorted(
        path
        for path in DRIVERS_DIR.rglob("*.nim")
        # ePaper/ is the vendored Waveshare C shim wrapper: no Nim refs, and
        # thousands of lines of generated bindings.
        if "ePaper" not in path.parts and "tests" not in path.parts
    )


def test_driver_sources_are_present():
    # A rename that empties the glob would make every check below vacuous.
    names = {path.name for path in driver_sources()}
    assert {"frameBuffer.nim", "inky.nim", "waveshare.nim", "inkyHyperPixel2r.nim"} <= names


def test_no_driver_stores_an_image_or_the_host_context():
    offenders: list[str] = []
    for path in driver_sources():
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            if FORBIDDEN_FIELD.match(line) or FORBIDDEN_GLOBAL.match(line):
                offenders.append(f"{path.relative_to(DRIVERS_DIR)}:{number}: {line.strip()}")

    assert not offenders, (
        "A driver may not keep an `Image` or a `DriverContext` past the call that handed it over "
        "— see frameos/src/frameos/driver_abi.nim. Copy the pixels (seq[uint8]/seq[ColorRGBX]) or "
        "hash them instead.\n" + "\n".join(offenders)
    )


def test_the_lint_catches_the_shapes_it_claims_to():
    # Without this, a regex typo would silently turn the check above into
    # "assert not []".
    assert FORBIDDEN_FIELD.match("  lastImage*: Image")
    assert FORBIDDEN_FIELD.match("  context: DriverContext")
    assert FORBIDDEN_FIELD.match("  frames*: seq[Image]")
    assert FORBIDDEN_GLOBAL.match("var lastRenderedImage: Image")
    # ...and leaves the value-copy shapes every driver actually uses alone.
    assert not FORBIDDEN_FIELD.match("  lastImageBytes*: int")
    assert not FORBIDDEN_FIELD.match("  lastImageData: seq[ColorRGBX]")
    assert not FORBIDDEN_FIELD.match("  screenInfo*: ScreenInfo")
    assert not FORBIDDEN_GLOBAL.match("var lastPixels: seq[uint8] = @[]")
