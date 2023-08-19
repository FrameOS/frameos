
from PIL import Image
import requests
import io
from typing import TYPE_CHECKING
from apps.apps import FrameConfig, App

class DownloadApp(App):
    def process_image(self, image: Image):
        if image_url := self.app_config.get('url', None):
            image_url.replace('{width}', str(self.frame_config.width))
            image_url.replace('{height}', str(self.frame_config.height))
            response = requests.get(image_url)
            image = Image.open(io.BytesIO(response.content))
        return image
