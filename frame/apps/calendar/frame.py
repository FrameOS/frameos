from PIL import Image, ImageDraw, ImageFont
from datetime import datetime
from apps import App, ProcessImagePayload
import calendar
from frame.image_utils import draw_text_with_border


class CalendarApp(App):
    def process_image(self, payload: ProcessImagePayload):
        width, height = payload.next_image.size if payload.next_image else (self.frame_config.width, self.frame_config.height)
        
        if payload.next_image is None:
            payload.next_image = Image.new('RGB', (width, height), color='white')
        
        # Get the current month details
        now = datetime.now()
        month_name = now.strftime('%B')
        year = now.strftime('%Y')
        _, last_day = calendar.monthrange(now.year, now.month)
        
        start_day_config = self.config.get('start_day', 'Sunday')
        start_day = 0 if start_day_config == "Sunday" else 1
        
        # Config settings
        font_color = self.config.get('font_color', 'black')
        font_size = int(self.config.get('font_size', 40))
        border_color = self.config.get('border_color', 'white')
        border_width = int(self.config.get('border_width', 2))
        calendar_width_percentage = float(self.config.get('calendar_width_percentage', '80')) / 100
        calendar_height_percentage = float(self.config.get('calendar_height_percentage', '80')) / 100
        position = self.config.get('position', 'center-center')
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", font_size)

        title_font_color = self.config.get('title_font_color', 'black')
        title_font_size = int(self.config.get('title_font_size', 50))
        title_border_color = self.config.get('title_border_color', 'white')
        title_border_width = int(self.config.get('title_border_width', 2))
        title_font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", title_font_size)

        today_font_color = self.config.get('today_font_color', 'red')
        today_font_size = int(self.config.get('today_font_size', 60))
        today_border_color = self.config.get('today_border_color', 'black')
        today_border_width = int(self.config.get('today_border_width', 2))
        today_font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", today_font_size)

        draw = ImageDraw.Draw(payload.next_image)
        
        # Determine the first weekday of the month (0 = Monday, 6 = Sunday)
        first_weekday_of_month = calendar.monthrange(now.year, now.month)[0]

        if start_day == 0:  # Sunday as the start of the week
            current_day = 1 - first_weekday_of_month + 6  # +6 because Sunday is represented as 6 in the weekday
        else:  # Monday as the start of the week
            current_day = 1 - first_weekday_of_month

        # The logic to determine the number of rows required for the month
        days_in_month = last_day
        total_cells = first_weekday_of_month + days_in_month  # number of days plus the starting position
        max_rows = 1 + (total_cells + 6) // 7  # ceil division

        # Calculate cell size and start position
        padding = 4
        cell_width = (width - 2 * padding) * calendar_width_percentage / 7
        cell_height = (height - 2 * padding) * calendar_height_percentage / max_rows

        if position == 'top-left':
            start_x, start_y = padding, padding
        elif position == 'top-center':
            start_x = (width - cell_width * 7) / 2
            start_y = padding
        elif position == 'top-right':
            start_x = width - cell_width * 7 - padding
            start_y = padding
        elif position == 'center-left':
            start_x = padding
            start_y = (height - cell_height * max_rows) / 2
        elif position == 'center-center':
            start_x = (width - cell_width * 7) / 2
            start_y = (height - cell_height * max_rows) / 2
        elif position == 'center-right':
            start_x = width - cell_width * 7 - padding
            start_y = (height - cell_height * max_rows) / 2
        elif position == 'bottom-left':
            start_x = padding
            start_y = height - cell_height * max_rows - padding
        elif position == 'bottom-center':
            start_x = (width - cell_width * 7) / 2
            start_y = height - cell_height * max_rows - padding
        elif position == 'bottom-right':
            start_x = width - cell_width * 7 - padding
            start_y = height - cell_height * max_rows - padding

        # Vertical lines
        for i in range(8):  # There are 8 lines for 7 columns
            line_start_x = start_x + i * cell_width
            line_start_y = start_y + cell_height  # Start below the month title
            line_end_x = line_start_x
            line_end_y = line_start_y + (max_rows - 1) * cell_height
            draw.line([(line_start_x, line_start_y), (line_end_x, line_end_y)], fill=border_color)

        # Horizontal lines
        for i in range(max_rows + 1):  # There are max_rows+1 lines
            line_start_x = start_x
            line_start_y = start_y + i * cell_height + cell_height  # Start below the month title
            line_end_x = start_x + 7 * cell_width
            line_end_y = line_start_y
            draw.line([(line_start_x, line_start_y), (line_end_x, line_end_y)], fill=border_color)

        # Draw month name at the top
        title_text = self.config.get('title_template', "Let's pretend it's \"{month}\"")
        title_text = title_text.replace('{month}', month_name)
        title_text = title_text.replace('{year}', year)
        title_alignment = self.config.get('title_alignment', 'left')

        title_width, title_height = title_font.getsize(title_text)
        title_height *= 1.15
        if title_alignment == 'center':
            title_x = start_x + (7 * cell_width - title_width) / 2
        elif title_alignment == 'right':
            title_x = start_x + 7 * cell_width - title_width
        else:  # left by default
            title_x = start_x

        title_y = start_y + (cell_height - title_height) / 2

        draw_text_with_border(draw, (title_x, title_y), title_text, title_font, title_font_color, title_border_color, title_border_width)

        # Draw the calendar grid
        current_day = 1 - (start_day + 1)
        for row in range(max_rows):
            for col in range(7):
                if 1 <= current_day <= last_day:
                    day_text = str(current_day)
                    if current_day == now.day:
                        text_width, text_height = draw.textsize(day_text, font=today_font)
                    else:
                        text_width, text_height = draw.textsize(day_text, font=font)
                    text_height *= 1.15
                        
                    x = start_x + col * cell_width + (cell_width - text_width) / 2
                    y = start_y + (row + 1) * cell_height + (cell_height - text_height) / 2
                    if current_day == now.day:
                        draw_text_with_border(draw, (x, y), day_text, today_font, today_font_color, today_border_color, today_border_width)
                    else:
                        draw_text_with_border(draw, (x, y), day_text, font, font_color, border_color, border_width)
                current_day += 1
        
        self.log(f"Added calendar for month: {month_name}")