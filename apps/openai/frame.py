from PIL import Image, UnidentifiedImageError
from apps.apps import App, ProcessImagePayload
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
            img = Image.open(io.BytesIO(image_response.content))            
            self.log(f"Image: {img.width}x{img.height} {img.format} {img.mode}")
            payload.next_image = resize_and_crop(img, self.frame_config.width, self.frame_config.height)
            self.log(f"Resized image: {payload.next_image.width}x{payload.next_image.height} {payload.next_image.format} {payload.next_image.mode}")
        except RequestException as e:
            raise Exception(f"Error fetching image from DALL·E 2 API. Error: {e}")
        except UnidentifiedImageError:
            raise Exception(f"The content returned from DALL·E 2 is not a valid image format.")

def resize_and_crop(image: Image.Image, target_width: int, target_height: int) -> Image.Image:
    # Determine the scaling factor for both dimensions
    scale_width = target_width / image.width
    scale_height = target_height / image.height
    
    # Choose the larger scaling factor to ensure the image covers the full area
    scale_factor = max(scale_width, scale_height)
    
    # Resize the image based on the chosen scaling factor
    new_width = round(image.width * scale_factor)
    new_height = round(image.height * scale_factor)
    image = image.resize((new_width, new_height), Image.ANTIALIAS)

    # Calculate cropping coordinates
    left = (image.width - target_width) / 2
    top = (image.height - target_height) / 2
    right = (image.width + target_width) / 2
    bottom = (image.height + target_height) / 2

    # Crop to the target size
    image = image.crop((left, top, right, bottom))

    return image
