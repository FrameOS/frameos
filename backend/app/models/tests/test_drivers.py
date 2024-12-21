from app.drivers.waveshare import get_variant_keys, convert_waveshare_source
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
