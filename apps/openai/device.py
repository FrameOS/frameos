
from PIL import Image
from apps.apps import App
import requests
import io

class OpenAIApp(App):
    def process_image(self, image: Image):
        if self.app_config.get('api_key', None) is None:
            raise ValueError("No API key provided for DALL·E 2")
        
        if prompt := self.app_config.get('prompt', None):
            response = requests.post('https://dalle2.openai.com/generate', json={'prompt': prompt})

            if response.status_code == 200:
                return Image.open(io.BytesIO(response.content))
            else:
                raise ValueError("Failed to generate image from DALL·E 2")
        return image
