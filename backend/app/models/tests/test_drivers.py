from app.drivers.waveshare import get_variant_keys, convert_waveshare_source
from app.models.frame import new_frame
from app.tests.base import BaseTestCase

class TestDrivers(BaseTestCase):

    def setUp(self):
        super().setUp()
        self.frame = new_frame("frame", "pi@192.168.1.1:8787", "server_host.com", "device_test")

    def test_waveshare_variants(self):
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
            assert variant.display_function is not None

            # TODO: color options