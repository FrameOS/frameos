from app.ha.client import ha_url_hostname, mqtt_config_from_settings


def test_ha_url_hostname():
    assert ha_url_hostname({"url": "http://homeassistant.local:8123"}) == "homeassistant.local"
    assert ha_url_hostname({"url": "https://ha.example.com/"}) == "ha.example.com"
    assert ha_url_hostname({"url": "homeassistant.local:8123"}) == "homeassistant.local"
    assert ha_url_hostname({"url": ""}) is None
    assert ha_url_hostname({}) is None


def test_mqtt_config_explicit_host():
    config = mqtt_config_from_settings(
        {"mqttHost": "broker.local", "mqttPort": "1884", "mqttUsername": "frameos", "mqttPassword": "secret"}
    )
    assert config is not None
    assert config.host == "broker.local"
    assert config.port == 1884
    assert config.username == "frameos"
    assert config.password == "secret"


def test_mqtt_config_host_defaults_to_ha_url_hostname():
    config = mqtt_config_from_settings(
        {"url": "http://homeassistant.local:8123", "mqttUsername": "frameos", "mqttPassword": "secret"}
    )
    assert config is not None
    assert config.host == "homeassistant.local"
    assert config.port == 1883


def test_mqtt_config_host_defaults_without_ha_url():
    config = mqtt_config_from_settings({"mqttUsername": "frameos", "mqttPassword": "secret"})
    assert config is not None
    assert config.host == "homeassistant.local"


def test_mqtt_config_skipped_when_everything_empty():
    assert mqtt_config_from_settings({}) is None
    assert mqtt_config_from_settings({"url": "http://homeassistant.local:8123"}) is None
    assert mqtt_config_from_settings({"mqttHost": "", "mqttUsername": " ", "mqttPassword": ""}) is None


def test_mqtt_config_invalid_port_falls_back():
    config = mqtt_config_from_settings({"mqttHost": "broker.local", "mqttPort": "not-a-port"})
    assert config is not None
    assert config.port == 1883
    assert config.username is None
