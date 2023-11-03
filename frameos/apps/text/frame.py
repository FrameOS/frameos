from PIL import Image, ImageDraw, ImageFont
from datetime import datetime
from apps import App, ExecutionContext
from frame.image_utils import draw_text_with_border

class ClockApp(App):
    def run(self, context: ExecutionContext):
        text = self.get_config('text', '')

        # Get the config settings
        font_color = self.get_config('font_color', 'black')
        font_size = int(self.get_config('font_size', 20))
        position = self.get_config('position', 'center-center')
        border_color = self.get_config('border_color', 'white')
        border_width = int(self.get_config('border_width', 1))
        
        # Prepare to draw the text
        draw = ImageDraw.Draw(context.image)
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", font_size)
        text_width, text_height = draw.textsize(text, font=font)
        text_width += border_width * 2
        text_height += border_width * 2
        align = 'left'
        
        # Positioning the text
        x, y = 4, 4
        if position == 'top-right':
            x = context.image.width - text_width - 4
            align = 'right'
        elif position == 'top-center':
            x = (context.image.width - text_width) / 2
            align = 'center'
        elif position == 'bottom-left':
            y = context.image.height - text_height - 4
        elif position == 'bottom-center':
            x = (context.image.width - text_width) / 2
            y = context.image.height - text_height - 4
            align = 'center'
        elif position == 'bottom-right':
            x = context.image.width - text_width - 4
            align = 'right'
        elif position == 'center-left':
            y = (context.image.height - text_height) / 2
        elif position == 'center-center':
            x = (context.image.width - text_width) / 2
            y = (context.image.height - text_height) / 2
            align = 'center'
        elif position == 'center-right':
            x = context.image.width - text_width - 4
            y = (context.image.height - text_height) / 2
            align = 'right'

        offset_x = int(self.get_config('offset_x', '0'))
        offset_y = int(self.get_config('offset_y', '0'))

        x += offset_x
        y += offset_y

        # Draw the text on the image
        if border_width != 0:
            draw_text_with_border(draw, (x, y), text, font, font_color, border_color, border_width, align)
        else:
            draw.text((x, y), text, fill=font_color, font=font, align=align)
        self.log(f"Drew text: {text} at position {position}")
