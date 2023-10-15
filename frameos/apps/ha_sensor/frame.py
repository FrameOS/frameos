import requests as requests

from apps import App, ExecutionContext

class SensorApp(App):
    def run(self, context: ExecutionContext):
        self.log("sensor app")
        ha_url = self.get_setting('home_assistant', 'url')
        if not ha_url:
            raise ValueError("Please provide a Home Assistant URL in the settings.")
        access_token = self.get_setting('home_assistant', 'access_token')
        if not access_token:
            raise ValueError("Please provide a Home Assistant access token in the settings.")

        sensor = self.config.get('sensor')
        state_key = self.config.get('state_key')
        url = f"{ha_url}/api/states/{sensor}"
        headers = {
            "Authorization": f"Bearer {access_token}",
            "content-type": "application/json",
        }
        response = requests.get(url, headers=headers)
        if response.status_code == 200:
            if state_key:
                context.state[state_key] = response.json()
            self.log(response.json())
        else:
            self.log(f"Failed to get the state of the sensor. Response code: {response.status_code}")
