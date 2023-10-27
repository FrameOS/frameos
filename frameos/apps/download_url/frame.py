from PIL import Image, UnidentifiedImageError
import requests
from requests.exceptions import RequestException
import io
from apps import App, ExecutionContext
from frame.image_utils import scale_image


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
            downloaded = Image.open(io.BytesIO(response.content))
            scaling_mode = self.get_config('scaling_mode', 'cover')
            self.log(f"Image: {downloaded.width}x{downloaded.height} {downloaded.format} {downloaded.mode}. Scaling mode: {scaling_mode}")
            context.image = scale_image(downloaded, context, scaling_mode, self.frame_config.background_color)

        except RequestException as e:
            raise Exception(f"Error fetching image from {image_url}. Error: {e}")
        except UnidentifiedImageError:
            raise Exception(f"The content at {image_url} is not a valid image format")
