from datetime import datetime, timedelta
from typing import Optional

from PIL import Image, UnidentifiedImageError
from apps import App, ProcessImagePayload
import requests
from requests.exceptions import RequestException
import io

class UnsplashApp(App):
    def __post_init__(self):
        self.cached_content: Optional[bytes] = None
        self.cache_seconds = float(self.config.get('cache_seconds', '60'))
        self.cache_expires_at: Optional[datetime] = None

    def process_image(self, payload: ProcessImagePayload):
        image_url = "https://source.unsplash.com/random/{width}x{height}/?{keyword}"
        width, height = payload.next_image.size
        image_url = image_url.replace('{width}', str(width))
        image_url = image_url.replace('{height}', str(height))
        image_url = image_url.replace('{keyword}', str(self.config.get('keyword', 'nature')))

        if self.cached_content is not None and self.cache_expires_at > datetime.now():
            self.log(f"Using cached image from Unsplash. Expires at: {self.cache_expires_at}")
            payload.next_image = Image.open(io.BytesIO(self.cached_content))
            return

        self.log(f"Fetching image from Unsplash: {image_url}")

        try:
            response = requests.get(image_url)
            response.raise_for_status()

            content_type = response.headers.get('content-type')
            if 'image' not in content_type:
                raise ValueError(f"Expected an image, but got content type: {content_type}")

            self.cached_content = response.content
            self.cache_expires_at = datetime.now() + timedelta(seconds=self.cache_seconds)
            payload.next_image = Image.open(io.BytesIO(response.content))
        except RequestException as e:
            raise Exception(f"Error fetching image from Unsplash. Error: {e}")
        except UnidentifiedImageError:
            raise Exception(f"Content returned from Unsplash is not in a valid image format. URL: {image_url}")
