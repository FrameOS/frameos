from PIL import Image, UnidentifiedImageError
import requests
from requests.exceptions import RequestException
import io
from typing import Optional
from apps.apps import App

class DownloadApp(App):
    def process_image(self, image: Optional[Image.Image]) -> Optional[Image.Image]:
        if image is not None:
            raise Exception('Image already present, will not override')

        image_url = self.app_config.get('url', None)
        if not image_url:
            raise ValueError("Image URL is not provided in app config")

        image_url = image_url.replace('{width}', str(self.frame_config.width))
        image_url = image_url.replace('{height}', str(self.frame_config.height))
        
        try:
            response = requests.get(image_url)
            response.raise_for_status()
            image = Image.open(io.BytesIO(response.content))
        except RequestException as e:
            raise Exception(f"Error fetching image from {image_url}. Error: {e}")
        except UnidentifiedImageError:
            raise Exception(f"The content at {image_url} is not a valid image format")
        
        return image
