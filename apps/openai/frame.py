from PIL import Image, UnidentifiedImageError
from apps.apps import App, ProcessImagePayload
import requests
from requests.exceptions import RequestException
import io

class OpenAIApp(App):
    def process_image(self, payload: ProcessImagePayload):
        if payload.next_image is not None:
            raise Exception('Image already present, will not override')
            
        if self.app_config.get('api_key', None) is None:
            raise ValueError("No API key provided for DALL·E 2")

        prompt = self.app_config.get('prompt', None)
        if not prompt:
            raise ValueError("No prompt provided in app config")

        try:
            response = requests.post('https://dalle2.openai.com/generate', json={'prompt': prompt})
            response.raise_for_status()
            payload.next_image = Image.open(io.BytesIO(response.content))
        except RequestException as e:
            raise Exception(f"Error fetching image from DALL·E 2 API. Error: {e}")
        except UnidentifiedImageError:
            raise Exception("The content returned from DALL·E 2 is not a valid image format")
