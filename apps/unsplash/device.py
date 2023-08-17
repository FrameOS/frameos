
from PIL import Image
from apps.apps import App
import requests
import io

class UnsplashApp(App):
    def process_image(self, image: Image):
        image_url = "https://source.unsplash.com/random/{width}x{height}/?{keyword}"
        image_url = image_url.replace('{width}', str(self.frame_config.width))
        image_url = image_url.replace('{height}', str(self.frame_config.height))
        image_url = image_url.replace('{keyword}', str(self.app_config.get('keyword', 'nature')))
        response = requests.get(image_url)

        if response.status_code != 200:
            raise ValueError(f"Failed to fetch image. Status code: {response.status_code}, URL: {image_url}")

        content_type = response.headers.get('content-type')
        if 'image' not in content_type:
            raise ValueError(f"Expected an image, but got content type: {content_type}, URL: {image_url}")

        image = Image.open(io.BytesIO(response.content))
        return image
