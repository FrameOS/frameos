from PIL import Image, UnidentifiedImageError
from apps import App, ExecutionContext
import requests
from requests.exceptions import RequestException
import io
import json
from frame.image_utils import scale_cover, scale_contain, scale_stretch, scale_center

class OpenAIApp(App):
    def run(self, context: ExecutionContext):
        api_key = self.get_setting(['openai', 'api_key'], None)
        if api_key is None:
            raise ValueError("Please provide an OpenAI API key in the settings.")

        prompt = self.get_config('prompt', None)
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
            image_response = requests.get(image_url)
            image_response.raise_for_status()
            openai_image = Image.open(io.BytesIO(image_response.content))
            scaling_mode = self.get_config('scaling_mode', 'cover')
            self.log(f"Image: {openai_image.width}x{openai_image.height} {openai_image.format} {openai_image.mode}. Scaling mode: {scaling_mode}")

            if openai_image.width == context.image.width and openai_image.height == context.image.height:
                context.image = openai_image
            else:
                if scaling_mode == 'contain':
                    context.image = scale_contain(openai_image, context.image.width, context.image.height, self.frame_config.background_color)
                elif scaling_mode == 'stretch':
                    context.image = scale_stretch(openai_image, context.image.width, context.image.height)
                elif scaling_mode == 'center':
                    context.image = scale_center(openai_image, context.image.width, context.image.height, self.frame_config.background_color)
                else:  # cover
                    context.image = scale_cover(openai_image, context.image.width, context.image.height)


        except RequestException as e:
            raise Exception(f"Error fetching image from DALL·E 2 API. Error: {e}")
        except UnidentifiedImageError:
            raise Exception(f"The content returned from DALL·E 2 is not a valid image format.")
