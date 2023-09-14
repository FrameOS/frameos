from PIL import Image, UnidentifiedImageError
import requests
from requests.exceptions import RequestException
import io
from apps import App, ExecutionContext

class DownloadApp(App):
    def run(self, context: ExecutionContext):
        image_url = self.config.get('url', None)
        if not image_url:
            raise ValueError("URL not provided in app config")
        width, height = context.image.size
        image_url = image_url.replace('{width}', str(width))
        image_url = image_url.replace('{height}', str(height))
        
        try:
            response = requests.get(image_url)
            response.raise_for_status()
            context.image = Image.open(io.BytesIO(response.content))
            self.log(f"Downloaded image: {context.image.width}x{context.image.height} {context.image.format} {context.image.mode}")
        except RequestException as e:
            raise Exception(f"Error fetching image from {image_url}. Error: {e}")
        except UnidentifiedImageError:
            raise Exception(f"The content at {image_url} is not a valid image format")
