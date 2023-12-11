from PIL import Image
from apps import App, ExecutionContext

class Colorapp(App):
    def run(self, context: ExecutionContext):
        color = self.get_config('color', '#FFFFFF')  # default to white if no color is specified
        width, height = context.image.size
        context.image = Image.new("RGB", (width, height), color)
        self.log(f"Created single color image: {width}x{height} with color {color}")
