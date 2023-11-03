from apps import App, ExecutionContext

class RotateApp(App):
    def run(self, context: ExecutionContext):
        # Get rotation degree from config
        degree = float(self.get_config('rotation_degree', 0))
        
        # Rotate the image
        context.image = context.image.rotate(degree, expand=True, fillcolor=self.frame_config.background_color or 'white')
        self.log(f"Rotated image by {degree} degrees. New dimensions: {context.image.width}x{context.image.height}")
