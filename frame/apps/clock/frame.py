from PIL import Image, ImageDraw, ImageFont
from datetime import datetime
from apps import App, ProcessImagePayload

class ClockApp(App):
    def process_image(self, payload: ProcessImagePayload):
        # If there's no next_image, create a blank canvas
        if payload.next_image is None:
            width, height = self.frame_config.width, self.frame_config.height
            payload.next_image = Image.new('RGB', (width, height), color='white')
        
        # Get the current time
        current_time = datetime.now().strftime('%H:%M:%S')
        
        # Get the config settings
        font_color = self.config.get('font_color', 'black')
        font_size = int(self.config.get('font_size', 20))
        position = self.config.get('position', 'top-left')
        border_color = self.config.get('border_color', 'white')
        border_width = int(self.config.get('border_width', 1))
        
        # Prepare to draw the text
        draw = ImageDraw.Draw(payload.next_image)
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", font_size)
        text_width, text_height = draw.textsize(current_time, font=font)
        text_width += border_width * 2
        text_height += border_width * 2
        
        # Positioning the text
        x, y = 4, 4
        if position == 'top-right':
            x = payload.next_image.width - text_width - 4
        elif position == 'top-center':
            x = (payload.next_image.width - text_width) / 2
        elif position == 'bottom-left':
            y = payload.next_image.height - text_height - 4
        elif position == 'bottom-center':
            x = (payload.next_image.width - text_width) / 2
            y = payload.next_image.height - text_height - 4
        elif position == 'bottom-right':
            x = payload.next_image.width - text_width - 4
        elif position == 'center-left':
            y = (payload.next_image.height - text_height) / 2
        elif position == 'center-center':
            x = (payload.next_image.width - text_width) / 2
            y = (payload.next_image.height - text_height) / 2
        elif position == 'center-right':
            x = payload.next_image.width - text_width - 4
            y = (payload.next_image.height - text_height) / 2

        # Draw the text on the image
        if border_width != 0:
            draw_text_with_border(draw, (x, y), current_time, font, font_color, border_color, border_width)
        else:
            draw.text((x, y), current_time, fill=font_color, font=font)
        self.log(f"Added clock: {current_time} at position {position}")


def draw_text_with_border(draw, position, text, font, font_color, border_color, border_width=1):
    x, y = position

    # Draw the border by offsetting the text by the thickness value in all directions
    for dx in range(-border_width, border_width+1):
        for dy in range(-border_width, border_width+1):
            draw.text((x+dx, y+dy), text, font=font, fill=border_color)

    # Draw the main text
    draw.text((x, y), text, fill=font_color, font=font)
