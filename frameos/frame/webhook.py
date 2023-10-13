import gzip
import json

import requests
import logging

from queue import Queue, Empty

from typing import List, Dict, Any
from threading import Thread, Event

from .config import Config

class Webhook:
    def __init__(self, config: Config):
        self.config = config
        self.queue = Queue()
        self.stop_event = Event()
        self.thread = Thread(target=self._run)
        self.thread.start()

    def add_log(self, payload: Dict[str, Any]):
        self.queue.put(payload)

    def _run(self):
        while not self.stop_event.is_set():
            batch = []
            
            # Start by getting at least one item. This will block if the queue is empty.
            item = self.queue.get()
            batch.append(item)

            # Then try to fill the batch up to its max size without blocking
            for _ in range(99):
                try:
                    item = self.queue.get_nowait()
                    batch.append(item)
                except Empty:
                    break

            self._send_batch(batch)

    def _send_batch(self, batch: List[Dict[str, Any]]):
        if not self.config:
            return
        protocol = 'https' if self.config.server_port % 1000 == 443 else 'http'
        url = f"{protocol}://{self.config.server_host}:{self.config.server_port}/api/log"
        headers = {
            "Authorization": f"Bearer {self.config.server_api_key}",
            "Content-Type": "application/json",
            "Content-Encoding": "gzip",
        }
        try:
            payload = json.dumps({"logs": batch}).encode('utf-8')
            response = requests.post(url, headers=headers, data=gzip.compress(payload))
            response.raise_for_status()
        except requests.HTTPError as e:
            logging.error(f"Error sending logs (HTTP {response.status_code}): {e}")
        except Exception as e:
            logging.error(f"Error sending logs: {e}")

    def stop(self):
        self.stop_event.set()
        self.thread.join()
