from PIL import Image
from apps import App, ProcessImagePayload

class Colorapp(App):
    def process_image(self, payload: ProcessImagePayload):
        color = self.config.get('color', '#FFFFFF')  # default to white if no color is specified
        width, height = payload.next_image.size

        payload.next_image = Image.new("RGB", (width, height), color)
        self.log(f"Created single color image: {width}x{height} with color {color}")

