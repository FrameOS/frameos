from apps import App, ProcessImagePayload

class CropApp(App):
    def process_image(self, payload: ProcessImagePayload):
        if payload.next_image is None:
            return
        
        # Get cropping coordinates from config
        left = int(self.config.get('left', 0))
        upper = int(self.config.get('upper', 0))
        right = int(self.config.get('right', payload.next_image.width))
        lower = int(self.config.get('lower', payload.next_image.height))
        
        # Crop the image
        payload.next_image = payload.next_image.crop((left, upper, right, lower))
        self.log(f"Cropped image to coordinates ({left}, {upper}, {right}, {lower})")
