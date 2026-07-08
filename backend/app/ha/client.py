"""
HTTP plumbing for the Home Assistant integration: resolving how to reach
Home Assistant (Supervisor APIs when running as an add-on, the configured
URL + long-lived token otherwise), fetching MQTT broker credentials, and
firing events on the HA event bus.
"""

from dataclasses import dataclass
from typing import Optional

from httpx import AsyncClient

from app.config import config

SUPERVISOR_CORE_API = "http://supervisor/core/api"
SUPERVISOR_MQTT_SERVICE = "http://supervisor/services/mqtt"


@dataclass
class RestConfig:
    base_url: str
    token: str


@dataclass
class MqttConfig:
    host: str
    port: int = 1883
    username: Optional[str] = None
    password: Optional[str] = None


def resolve_rest_config(ha_settings: dict) -> Optional[RestConfig]:
    """Where to POST HA event-bus events, or None if HA is unreachable.

    As an add-on the Supervisor proxies the Core API; standalone installs use
    the URL + long-lived access token from the Home Assistant settings.
    """
    if config.SUPERVISOR_TOKEN:
        return RestConfig(base_url=SUPERVISOR_CORE_API, token=config.SUPERVISOR_TOKEN)
    url = str(ha_settings.get("url") or "").strip().rstrip("/")
    token = str(ha_settings.get("accessToken") or "").strip()
    if url and token:
        return RestConfig(base_url=f"{url}/api", token=token)
    return None


async def fetch_supervisor_mqtt(client: AsyncClient) -> Optional[MqttConfig]:
    """Broker credentials from the Supervisor's Mosquitto service, if any."""
    if not config.SUPERVISOR_TOKEN:
        return None
    try:
        response = await client.get(
            SUPERVISOR_MQTT_SERVICE,
            headers={"Authorization": f"Bearer {config.SUPERVISOR_TOKEN}"},
            timeout=10,
        )
        if response.status_code != 200:
            return None
        data = response.json().get("data") or {}
        host = data.get("host")
        if not host:
            return None
        return MqttConfig(
            host=host,
            port=int(data.get("port") or 1883),
            username=data.get("username") or None,
            password=data.get("password") or None,
        )
    except Exception as e:
        print(f"🔴 Home Assistant sync: failed to fetch MQTT service from supervisor: {e}")
        return None


def mqtt_config_from_settings(ha_settings: dict) -> Optional[MqttConfig]:
    host = str(ha_settings.get("mqttHost") or "").strip()
    if not host:
        return None
    try:
        port = int(ha_settings.get("mqttPort") or 1883)
    except (TypeError, ValueError):
        port = 1883
    return MqttConfig(
        host=host,
        port=port,
        username=str(ha_settings.get("mqttUsername") or "").strip() or None,
        password=str(ha_settings.get("mqttPassword") or "") or None,
    )


async def resolve_mqtt_config(client: AsyncClient, ha_settings: dict) -> Optional[MqttConfig]:
    return await fetch_supervisor_mqtt(client) or mqtt_config_from_settings(ha_settings)


async def fire_ha_event(client: AsyncClient, rest: RestConfig, event_type: str, payload: dict) -> bool:
    try:
        response = await client.post(
            f"{rest.base_url}/events/{event_type}",
            json=payload,
            headers={"Authorization": f"Bearer {rest.token}"},
            timeout=10,
        )
        return response.status_code < 300
    except Exception as e:
        print(f"🔴 Home Assistant sync: failed to fire event {event_type}: {e}")
        return False
