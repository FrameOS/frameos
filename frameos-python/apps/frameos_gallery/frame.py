import json
from datetime import datetime, timedelta
from typing import Optional

from PIL import Image, UnidentifiedImageError
from apps import App, ExecutionContext
import requests
from requests.exceptions import RequestException
import io

from frame.image_utils import scale_image


class FrameOSGalleryApp(App):
    BASE_URL: str = 'https://gallery.frameos.net/image'

    def __post_init__(self):
        self.set_cache_config()

    def set_cache_config(self):
        self.cached_content: Optional[bytes] = None
        self.cache_seconds = float(self.config.get('cache_seconds', '60'))
        self.cache_url: Optional[str] = None
        self.cache_expires_at: Optional[datetime] = None

    def run(self, context: ExecutionContext):
        self.context = context
        image_url = self.generate_url(context)
        if self.is_cache_valid(image_url):
            new_image = self.get_image_from_cache()
        else:
            new_image = self.fetch_image(image_url)
        scaling_mode = self.get_config('scaling_mode', 'cover')
        context.image = scale_image(new_image, context.image.width, context.image.height, scaling_mode, self.frame_config.background_color)

    def generate_url(self, context):
        api_key = self.get_setting(['frameos', 'api_key'], None)
        width, height = context.image.size
        category = self.get_config('category', 'random')

        if api_key is None:
            self.log("FrameOS API key absent. Sign up at https://gallery.frameos.net/ to support the project.")
            api_key = ''

        url = f"{self.BASE_URL}?api_key={'' if api_key is None else api_key}&category={category}"
        self.log(f"Category: {category}, image_url: {url}")
        return url

    def is_cache_valid(self, url):
        return self.cached_content is not None and self.cache_expires_at > datetime.now() and self.cache_url == url

    def get_image_from_cache(self):
        self.log(f"Using cached image. Expires at: {self.cache_expires_at}")
        return Image.open(io.BytesIO(self.cached_content))

    def fetch_image(self, url):
        try:
            response = self.get_response(url)
            self.validate_response(response)

            self.set_cache(response.content, url)
            return Image.open(io.BytesIO(response.content))
        except RequestException as e:
            raise Exception(f"Error fetching FrameOS gallery image. Error: {e}")
        except UnidentifiedImageError:
            raise Exception(f"Content returned from FrameOS gallery is not a valid image. URL: {url}")

    def get_response(self, url):
        response = requests.get(url)
        response.raise_for_status()
        return response

    def validate_response(self, response):
        content_type = response.headers.get('content-type')
        if 'image' not in content_type:
            raise ValueError(f"Expected an image, but got content type: {content_type}")

    def set_cache(self, content, url):
        self.cached_content = content
        self.cache_expires_at = datetime.now() + timedelta(seconds=self.cache_seconds)
        self.cache_url = url
