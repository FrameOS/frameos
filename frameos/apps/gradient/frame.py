from PIL import Image, ImageDraw
from apps import App, ExecutionContext
import math

class GradientBackgroundApp(App):
    def run(self, context: ExecutionContext):
        start_color = tuple(int(self.config.get('start_color')[i:i+2], 16) for i in (1, 3, 5))
        end_color = tuple(int(self.config.get('end_color')[i:i+2], 16) for i in (1, 3, 5))
        angle = float(self.config.get('angle', 0))  # default angle is 0 (vertical)
        width, height = context.image.size

        # Calculate the diagonal length
        diagonal = int(math.ceil(math.sqrt(width**2 + height**2)))

        # Create an image based on the diagonal length
        base = Image.new('RGB', (diagonal, diagonal), start_color)
        top = Image.new('RGB', (diagonal, diagonal), end_color)
        mask = Image.new('L', (diagonal, diagonal))
        mask_data = []

        for y in range(diagonal):
            mask_data.extend([int(255 * (y / diagonal))] * diagonal)

        mask.putdata(mask_data)
        gradient = Image.composite(base, top, mask)

        # Rotate the image by the desired angle.
        rotated_gradient = gradient.rotate(-angle, expand=True, center=(diagonal/2, diagonal/2))

        # Crop to the desired size, ensuring the center remains the center.
        cx, cy = rotated_gradient.width // 2, rotated_gradient.height // 2
        context.image = rotated_gradient.crop((cx - width//2, cy - height//2, cx + width//2, cy + height//2))

        self.log(f"Created gradient image at angle {angle}: {width}x{height} from {start_color} to {end_color}")
