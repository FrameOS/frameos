import json
from apps import App, ExecutionContext

class HackRingraamApp(App):
    def run(self, context: ExecutionContext):
        state = context.state.get('water_heater', {}).get('state', {})

        if state == 'auto':
            context.state['keyword'] = 'ice'
        elif state == 'heat':
            context.state['keyword'] = 'fire'
        else:
            context.state['keyword'] = 'question'
