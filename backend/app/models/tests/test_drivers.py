from pathlib import Path

from app.drivers.drivers import Driver
from app.drivers.waveshare import get_variant_keys, convert_waveshare_source, write_waveshare_driver_nim
import pytest

@pytest.mark.asyncio
async def test_waveshare_variants():
    variants = get_variant_keys()
    assert len(variants) > 0
    assert "EPD_2in13_V2" in variants
    for variant_key in variants:
        assert variant_key.startswith("EPD_")
        try:
            variant = convert_waveshare_source(variant_key)
        except Exception as e:
            raise Exception(f"Failed to convert variant {variant_key}") from e
        assert variant.width > 0
        assert variant.height > 0
        assert variant.init_function is not None
        assert variant.clear_function is not None
        assert variant.sleep_function is not None
        assert variant.display_function is not None
        assert variant.color_option != "Unknown"


def test_epd_12in48_wrapper_uses_defined_max_constants():
    wrapper_path = (
        Path(__file__).resolve().parents[4]
        / "frameos"
        / "src"
        / "drivers"
        / "waveshare"
        / "epd12in48"
        / "EPD_12in48.nim"
    )
    wrapper_source = wrapper_path.read_text(encoding="utf-8")

    assert "EPD_MAX_WIDTH" not in wrapper_source
    assert "EPD_MAX_HEIGHT" not in wrapper_source


@pytest.mark.parametrize(
    ("variant_key", "expected_init_args"),
    [
        ("EPD_1in54", "EPD_1IN54_FULL"),
        ("EPD_2in13", "EPD_2IN13_FULL"),
        ("EPD_2in13_V2", "EPD_2IN13_V2_FULL"),
        ("EPD_2in9", "EPD_2IN9_FULL"),
    ],
)
def test_waveshare_variants_with_mode_init_use_full_mode(variant_key: str, expected_init_args: str):
    variant = convert_waveshare_source(variant_key)

    assert variant.init_args == expected_init_args


def test_waveshare_driver_init_embeds_variant_specific_boot_requirements():
    source = write_waveshare_driver_nim(
        {"waveshare": Driver(name="waveshare", variant="EPD_10in3")}
    )

    assert 'ensureBootConfigLines: @["dtoverlay=spi0-0cs"]' in source
    assert 'removeBootConfigLines: @["dtparam=spi=on"]' in source
    assert "spiMode: dismEnable" in source


def test_waveshare_driver_init_disables_spi_for_epd_13in3e():
    source = write_waveshare_driver_nim(
        {"waveshare": Driver(name="waveshare", variant="EPD_13in3e")}
    )

    assert 'ensureBootConfigLines: @["gpio=7=op,dl", "gpio=8=op,dl"]' in source
    assert "spiMode: dismDisable" in source
