from apps import App, ProcessImagePayload
from frame.image_utils import scale_cover, scale_contain, scale_stretch, scale_center
from PIL import Image

class ResizeApp(App):
    def process_image(self, payload: ProcessImagePayload):
        if payload.next_image is None:
            return
        
        # Get scale factors from config
        width = int(self.config.get('width', 1))
        height = int(self.config.get('height', 1))
        scaling_mode = self.config.get('scaling_mode')

        current_width = payload.next_image.width
        current_height = payload.next_image.height

        # Scale the image
        if scaling_mode == 'contain':
            payload.next_image = scale_contain(payload.next_image, width, height, self.frame_config.background_color)
        elif scaling_mode == 'stretch':
            payload.next_image = scale_stretch(payload.next_image, width, height)
        elif scaling_mode == 'center':
            payload.next_image = scale_center(payload.next_image, width, height, self.frame_config.background_color)
        else: # cover
            payload.next_image = scale_cover(payload.next_image, width, height)

        self.log(f"Resized image from {current_width}x{current_height} to {payload.next_image.width}x{payload.next_image.height} using scaling mode: {scaling_mode}")
