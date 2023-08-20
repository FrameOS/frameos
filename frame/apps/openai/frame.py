from PIL import Image, UnidentifiedImageError
from apps import App, ProcessImagePayload
import requests
from requests.exceptions import RequestException
import io
import json
class OpenAIApp(App):
    def process_image(self, payload: ProcessImagePayload):
        if payload.next_image is not None:
            raise Exception('Image already present, will not override')
            
        api_key = self.config.get('api_key', None)
        if api_key is None:
            raise ValueError("No API key provided for DALL·E 2")

        prompt = self.config.get('prompt', None)
        if not prompt:
            raise ValueError("No prompt provided in app config")

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        
        try:
            response = requests.post(
                'https://api.openai.com/v1/images/generations',
                headers=headers,
                json={'prompt': prompt, 'n': 1, 'size': '1024x1024'}
            )
            response.raise_for_status()
            response_json = json.loads(response.content)
            image_url = response_json.get('data', [{}])[0].get('url')
            self.log(f"Image url: {image_url}")

            image_response = requests.get(image_url)
            image_response.raise_for_status()
            payload.next_image = Image.open(io.BytesIO(image_response.content))            
            self.log(f"Image: {payload.next_image.width}x{payload.next_image.height} {payload.next_image.format} {payload.next_image.mode}")
        except RequestException as e:
            raise Exception(f"Error fetching image from DALL·E 2 API. Error: {e}")
        except UnidentifiedImageError:
            raise Exception(f"The content returned from DALL·E 2 is not a valid image format.")
