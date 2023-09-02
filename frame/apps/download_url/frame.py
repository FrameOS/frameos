from PIL import Image, UnidentifiedImageError
import requests
from requests.exceptions import RequestException
import io
from apps import App, ProcessImagePayload

class DownloadApp(App):
    def process_image(self, payload: ProcessImagePayload):
        image_url = self.config.get('url', None)
        if not image_url:
            raise ValueError("URL not provided in app config")
        width, height = payload.next_image.size
        image_url = image_url.replace('{width}', str(width))
        image_url = image_url.replace('{height}', str(height))
        
        try:
            response = requests.get(image_url)
            response.raise_for_status()
            payload.next_image = Image.open(io.BytesIO(response.content))
            self.log(f"Downloaded image: {payload.next_image.width}x{payload.next_image.height} {payload.next_image.format} {payload.next_image.mode}")
        except RequestException as e:
            raise Exception(f"Error fetching image from {image_url}. Error: {e}")
        except UnidentifiedImageError:
            raise Exception(f"The content at {image_url} is not a valid image format")
