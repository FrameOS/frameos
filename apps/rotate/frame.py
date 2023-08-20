from apps.apps import App, ProcessImagePayload

class RotateApp(App):
    def process_image(self, payload: ProcessImagePayload):
        # Get rotation degree from config
        degree = float(self.config.get('rotation_degree', 0))
        
        # Rotate the image
        payload.next_image = payload.next_image.rotate(degree, expand=True, fillcolor=self.frame_config.background_color or 'white')
        self.log(f"Rotated image by {degree} degrees. New dimensions: {payload.next_image.width}x{payload.next_image.height}")
