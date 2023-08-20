from PIL import Image
from apps import App, ProcessImagePayload

class Colorapp(App):
    def process_image(self, payload: ProcessImagePayload):
        if payload.next_image is not None:
            raise Exception('Image already present, will not override')

        color = self.config.get('color', '#FFFFFF')  # default to white if no color is specified
        width = self.frame_config.width
        height = self.frame_config.height

        payload.next_image = Image.new("RGB", (width, height), color)
        self.log(f"Created single color image: {width}x{height} with color {color}")

