import requests as requests

from apps import App, ExecutionContext

class SensorApp(App):
    def run(self, context: ExecutionContext):
        self.log("sensor app")
        access_token = self.config.get('access_token')
        sensor = self.config.get('sensor')
        ha_url = self.config.get('ha_url')
        url = f"{ha_url}/api/states/sensor.{sensor}"
        headers = {
            "Authorization": f"Bearer {access_token}",
            "content-type": "application/json",
        }

        response = requests.get(url, headers=headers)

        if response.status_code == 200:
            self.log(response.json())
        else:
            self.log(f"Failed to get the state of the sensor. Response code: {response.status_code}")
