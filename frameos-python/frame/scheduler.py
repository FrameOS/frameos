from threading import Thread, Event

from .logger import Logger
from .config import Config
from .image_handler import ImageHandler

class Scheduler:
    def __init__(self, image_handler: ImageHandler, reset_event: Event, logger: Logger, config: Config):
        self.logger = logger
        self.config = config
        self.image_handler = image_handler
        self.reset_event = reset_event
        self.schedule_thread: Thread = Thread(target=self.update_image_on_schedule)

        logger.log({ 'event': '@frame:schedule_start', 'interval': self.config.interval })
        self.schedule_thread.start()

    def update_image_on_schedule(self):
        while True:
            self.reset_event.wait(self.config.interval)  
            self.image_handler.render_image('schedule')
            self.reset_event.clear()  
