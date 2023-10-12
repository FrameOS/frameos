import io

import requests
from PIL import Image, ImageDraw, ImageFont
from apps import App, ExecutionContext
from frame.image_utils import draw_text_with_border

class BoilerplateApp(App):
    state = {}
    def run(self, context: ExecutionContext):
        # Each execution starts from an event. The most common event is "render".
        self.log(f"logging logging log: {context.event == 'render'}")

        # In the render context you can modify an image.
        width, height = context.image.size

        # Swap it out if you want to
        image_url = f"https://source.unsplash.com/random/{width}x{height}/?nature"
        response = requests.get(image_url)
        context.image = Image.open(io.BytesIO(response.content))

        # Access config
        my_name = self.config.get('my_name', "Bananas")

        # Draw some text on it
        text = f"FrameOS is {my_name}"
        draw = ImageDraw.Draw(context.image)
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 48 if width > 500 else 24)
        text_width, text_height = draw.textsize(text, font=font)
        x, y = (width - text_width) / 2, (height - text_height) / 2
        # draw.text((x, y), text, fill='white', font=font) # boring
        draw_text_with_border(draw, (x, y), text, font, 'white', 'black', 3)

        # You can use the context's "state" to carry random data between apps.
        # It's cleared each execution.
        context.state["really_bananas"] = "i know right"

        # Use class variables to carry state between executions.
        self.state["bananas"] = "yes"

        # Ask ChatGPT for other PIL drawing commands and go, well, you know it by now: bananas

