import os
import psutil
from threading import Thread, Event

from .logger import Logger
from .config import Config
from .image_handler import ImageHandler

class MetricsLogger:
    def __init__(self, image_handler: ImageHandler, reset_event: Event, logger: Logger, config: Config):
        if config.metrics_interval == 0:
            logger.log({'event': '@frame:metrics_logger', 'state': 'disabled'})
            return
        self.logger = logger
        self.config = config
        self.image_handler = image_handler
        self.reset_event = reset_event
        self.thread: Thread = Thread(target=self.send_metrics)
        logger.log({ 'event': '@frame:metrics_logger', 'state': 'enabled', 'interval': self.config.metrics_interval })
        self.thread.start()

    def get_load_average(self):
        return os.getloadavg()

    def get_cpu_temperature(self):
        try:
            with open("/sys/class/thermal/thermal_zone0/temp", "r") as temp_file:
                cpu_temp = int(temp_file.read()) / 1000.0
            return cpu_temp
        except IOError:
            return None

    def get_memory_usage(self):
        memory_info = psutil.virtual_memory()
        return {
            "total": memory_info.total,
            "used": memory_info.used,
            "free": memory_info.free,
            "percentage": memory_info.percent
        }

    def get_cpu_usage(self):
        return psutil.cpu_percent(interval=1)

    def send_metrics_once(self):
        metrics = {
            'event': '@frame:metrics',
            'load': self.get_load_average(),
            'cpu_temperature': self.get_cpu_temperature(),
            'memory_usage': self.get_memory_usage(),
            'cpu_usage': self.get_cpu_usage()
        }
        self.logger.log(metrics)

    def send_metrics(self):
        while True:
            self.reset_event.wait(self.config.metrics_interval or 60)
            self.send_metrics_once()
            self.reset_event.clear()
