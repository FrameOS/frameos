import random
import re

from PIL import Image, UnidentifiedImageError
import requests
from requests.exceptions import RequestException
import io
from apps import App, ProcessImagePayload

class GooglePhotosApp(App):
    def process_image(self, payload: ProcessImagePayload):
        photos_url = self.config.get('photos_url', None)
        if not photos_url:
            raise ValueError("Photos URL is not provided in app config")

        width, height = payload.next_image.size
        photos_url = photos_url.replace('{width}', str(width))
        photos_url = photos_url.replace('{height}', str(height))
        
        try:
            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
            }

            response = requests.get(photos_url, headers=headers)
            response.raise_for_status()

            image_urls = re.findall(r'https://lh3\.googleusercontent\.com/pw/[a-zA-Z0-9\-_]+', response.text)
            random_image_url = random.choice(image_urls)
            self.log(f"Downloading: {random_image_url}")
            response = requests.get(random_image_url)
            response.raise_for_status()
            payload.next_image = Image.open(io.BytesIO(response.content))
            self.log(f"Downloaded image: {payload.next_image.width}x{payload.next_image.height} {payload.next_image.format} {payload.next_image.mode}")
        except RequestException as e:
            raise Exception(f"Error fetching image from {photos_url}. Error: {e}")
        except UnidentifiedImageError:
            raise Exception(f"The content at {photos_url} is not a valid image format")
