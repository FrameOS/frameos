from apps.apps import App, ProcessImagePayload

class ScaleApp(App):
    def process_image(self, payload: ProcessImagePayload):
        if payload.next_image is None:
            return
        
        # Get scale factors from config
        scale_width = float(self.config.get('scale_width', 1))
        scale_height = float(self.config.get('scale_height', 1))
        
        new_width = int(payload.next_image.width * scale_width)
        new_height = int(payload.next_image.height * scale_height)
        
        # Scale the image
        payload.next_image = payload.next_image.resize((new_width, new_height))
        self.log(f"Scaled image to {new_width}x{new_height}")
