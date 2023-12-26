from .app_handler import AppHandler
from .logger import Logger
from .image_handler import ImageHandler

class ButtonHandler:
    def __init__(self, logger: Logger, buttons: list, labels: list, image_handler: ImageHandler, app_handler: AppHandler):
        self.logger = logger
        self.buttons = buttons
        self.labels = labels
        self.image_handler = image_handler
        self.app_handler = app_handler
        try:
            import RPi.GPIO as GPIO
            GPIO.setmode(GPIO.BCM)
            GPIO.setup(buttons, GPIO.IN, pull_up_down=GPIO.PUD_UP)
            for pin in buttons:
                GPIO.add_event_detect(pin, GPIO.FALLING, self.handle_button, bouncetime=250)
        except Exception as e:
            logger.log({ 'event': '@frame:error_button_handler', 'error': str(e) })

    def handle_button(self, pin):
        label = self.labels[self.buttons.index(pin)]
        self.logger.log({ 'event': '@frame:button_pressed', 'label': label, 'pin': pin })
        self.app_handler.dispatch_event('button_press', payload={"label": label, "pin": pin})
