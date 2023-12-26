import io

import requests
from PIL import Image, ImageDraw, ImageFont
from apps import App, ExecutionContext
from frame.image_utils import draw_text_with_border

class BreakIfRenderingApp(App):
    def run(self, context: ExecutionContext):
        if self.is_rendering():
            self.break_execution(self.get_config('message', None))
