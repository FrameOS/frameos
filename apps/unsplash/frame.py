from PIL import Image, UnidentifiedImageError
from apps.apps import App, ProcessImagePayload
import requests
from requests.exceptions import RequestException
import io

class UnsplashApp(App):
    def process_image(self, payload: ProcessImagePayload):
        if payload.next_image is not None:
            raise Exception('Image already present, will not override')
        
        image_url = "https://source.unsplash.com/random/{width}x{height}/?{keyword}"
        image_url = image_url.replace('{width}', str(self.frame_config.width))
        image_url = image_url.replace('{height}', str(self.frame_config.height))
        image_url = image_url.replace('{keyword}', str(self.app_config.get('keyword', 'nature')))

        try:
            response = requests.get(image_url)
            response.raise_for_status()

            content_type = response.headers.get('content-type')
            if 'image' not in content_type:
                raise ValueError(f"Expected an image, but got content type: {content_type}")

            payload.next_image = Image.open(io.BytesIO(response.content))
        except RequestException as e:
            raise Exception(f"Error fetching image from Unsplash. Error: {e}")
        except UnidentifiedImageError:
            raise Exception(f"Content returned from Unsplash is not in a valid image format. URL: {image_url}")
