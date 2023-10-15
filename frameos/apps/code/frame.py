import io

import requests
from PIL import Image, ImageDraw, ImageFont
from apps import App, ExecutionContext
from frame.image_utils import draw_text_with_border

class CodeApp(App):
    def run(self, context: ExecutionContext):
        self.log(f"hello")

        if context.event == 'render':
            url = f"https://source.unsplash.com/random/{context.image.width}x{context.image.height}/?nature"
            context.image = Image.open(io.BytesIO(requests.get(url).content))

        if context.event == 'button_press':
            context.state['last_button'] = context.payload.get('label')

