from PIL import Image, UnidentifiedImageError
import requests
from requests.exceptions import RequestException
import io
from apps.apps import App, ProcessImagePayload

class DownloadApp(App):
    def process_image(self, payload: ProcessImagePayload):
        if payload.next_image is not None:
            raise Exception('Image already present, will not override')

        image_url = self.config.get('url', None)
        if not image_url:
            raise ValueError("Image URL is not provided in app config")

        image_url = image_url.replace('{width}', str(self.frame_config.width))
        image_url = image_url.replace('{height}', str(self.frame_config.height))
        
        try:
            response = requests.get(image_url)
            response.raise_for_status()
            payload.next_image = Image.open(io.BytesIO(response.content))
            self.log(f"Downloaded image: {payload.next_image.width}x{payload.next_image.height} {payload.next_image.format} {payload.next_image.mode}")
            if payload.next_image.width != self.frame_config.width or payload.next_image.height != self.frame_config.height:
                self.log(f"Resizing image to {self.frame_config.width}x{self.frame_config.height}")
                payload.next_image = resize_and_crop(payload.next_image, self.frame_config.width, self.frame_config.height)
        except RequestException as e:
            raise Exception(f"Error fetching image from {image_url}. Error: {e}")
        except UnidentifiedImageError:
            raise Exception(f"The content at {image_url} is not a valid image format")
        
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
