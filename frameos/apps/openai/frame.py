from PIL import Image, UnidentifiedImageError
from apps import App, ExecutionContext
import requests
from requests.exceptions import RequestException
import io
import json

class OpenAIApp(App):
    def run(self, context: ExecutionContext):
        api_key = self.get_setting('openai', 'api_key')
        if api_key is None:
            raise ValueError("Please provide an OpenAI API key in the settings.")

        prompt = self.get_config(context.state, 'prompt', None)
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
            openai_image = Image.open(io.BytesIO(image_response.content))
            # TODO: scale modes and retain width/height
            context.image = openai_image
            self.log(f"Image: {context.image.width}x{context.image.height} {context.image.format} {context.image.mode}")
        except RequestException as e:
            raise Exception(f"Error fetching image from DALL·E 2 API. Error: {e}")
        except UnidentifiedImageError:
            raise Exception(f"The content returned from DALL·E 2 is not a valid image format.")
