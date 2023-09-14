from apps import App, ExecutionContext
from frame.image_utils import scale_cover, scale_contain, scale_stretch, scale_center

class ReRenderApp(App):
    def run(self, context: ExecutionContext):
        self.rerender('rerender app')
