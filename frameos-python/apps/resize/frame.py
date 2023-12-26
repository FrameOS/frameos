from apps import App, ExecutionContext
from frame.image_utils import scale_cover, scale_contain, scale_stretch, scale_center

class ResizeApp(App):
    def run(self, context: ExecutionContext):
        if context.image is None:
            return
        
        # Get scale factors from config
        width = int(self.get_config('width', 1))
        height = int(self.get_config('height', 1))
        scaling_mode = self.get_config('scaling_mode')
        current_width = context.image.width
        current_height = context.image.height

        # Scale the image
        if scaling_mode == 'contain':
            context.image = scale_contain(context.image, width, height, self.frame_config.background_color)
        elif scaling_mode == 'stretch':
            context.image = scale_stretch(context.image, width, height)
        elif scaling_mode == 'center':
            context.image = scale_center(context.image, width, height, self.frame_config.background_color)
        else: # cover
            context.image = scale_cover(context.image, width, height)

        self.log(f"Resized image from {current_width}x{current_height} to {context.image.width}x{context.image.height} using scaling mode: {scaling_mode}")
