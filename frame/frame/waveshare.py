import importlib
import inspect

class WaveShare:
    SUPPORTED_DEVICES = [
        "epd1in02", "epd1in64g", "epd2in13", "epd2in66", "epd4in2b_V2", "epd5in83", "epd7in5b_V2",
        "epd1in54b", "epd2in13bc", "epd2in13_V2", "epd2in7b", "epd2in9bc", "epd3in0g", "epd4in2", "epd5in83_V2", "epd7in5_HD",
        "epd1in54b_V2", "epd2in13b_V3", "epd2in13_V3", "epd2in7b_V2", "epd2in9b_V3", "epd3in52", "epd4in37g", "epd7in3f", "epd7in5",
        "epd1in54c", "epd2in13b_V4", "epd2in13_V4", "epd2in7", "epd2in9d", "epd3in7", "epd5in65f", "epd7in3g", "epd7in5_V2_fast",
        "epd1in54", "epd2in13d", "epd2in36g", "epd2in9", "epd4in01f", "epd5in83bc", "epd7in5bc", "epd7in5_V2",
        "epd1in54_V2", "epd2in13g", "epd2in66b", "epd2in7_V2", "epd2in9_V2", "epd4in2bc", "epd5in83b_V2", "epd7in5b_HD",
    ]

    def __init__(self, device, logger):
        if device not in self.SUPPORTED_DEVICES:
            raise ValueError(f"Unsupported device: {device}")

        self.device = device
        self.logger = logger
        self.epd = None
        self.width = 0
        self.height = 0

        module = importlib.import_module(f'lib.waveshare_epd.{self.device}')
        EPDClass = getattr(module, 'EPD')
        self.epd = EPDClass()
        self.width = self.epd.width
        self.height = self.epd.height
        self.logger.log({'event': '@frame:device', "device": 'epd', 'info': f"{self.width} x {self.height}"})

    def init_device(self):
        # Get the number of parameters the init method expects
        params = inspect.signature(self.epd.init).parameters
        num_params = len(params)

        # If it expects more than just 'self', then provide the lut_full_update argument
        if num_params > 1 and hasattr(self.epd, 'lut_full_update'):
            self.epd.init(self.epd.lut_full_update)
        else:
            self.epd.init()

    def display_image(self, image):
        self.init_device()
        self.epd.display(self.epd.getbuffer(image))
        self.epd.sleep()
