from typing import Optional, List
import json
import os

local_apps_path = "../frameos/src/apps"

def get_app_configs() -> dict[str, dict]:
    configs = {}
    for keyword in os.listdir(local_apps_path):
        local_app_path = os.path.join(local_apps_path, keyword)
        if os.path.isdir(local_app_path):
            config_path = os.path.join(local_app_path, "config.json")
            if os.path.exists(config_path):
                try:
                    with open(config_path, 'r') as f:
                        config = json.load(f)
                        if 'name' in config:
                            configs[keyword] = config
                except Exception as e:
                    print(f"Error loading config for {keyword}: {e}")
    return configs


def get_local_frame_apps() -> List[str]:
    apps = os.listdir(local_apps_path)
    clean_apps: List[str] = []
    for keyword in apps:
        local_app_path = os.path.join(local_apps_path, keyword)
        app_path = os.path.join(local_app_path, "app.nim")
        config_path = os.path.join(local_app_path, "config.json")
        if os.path.exists(app_path) and os.path.exists(config_path):
            clean_apps.append(keyword)
    return clean_apps



def get_one_app_sources(keyword: str) -> Optional[dict[str, str]]:
    apps = os.listdir(local_apps_path)
    sources: dict[str, str] = {}
    if keyword in apps:
        local_app_path = os.path.join(local_apps_path, keyword)
        app_path = os.path.join(local_app_path, "app.nim")
        if os.path.exists(app_path):
            with open(app_path, 'r') as f:
                sources['app.nim'] = f.read()
        config_path = os.path.join(local_app_path, "config.json")
        if os.path.exists(config_path):
            with open(config_path, 'r') as f:
                sources['config.json'] = f.read()
    return sources



def get_apps_from_scenes(scenes: List[dict]) -> dict[str, dict]:
    apps = {}
    for scene in scenes:
        for node in scene.get('nodes', []):
            if node['type'] == 'app' and node.get('data', {}).get('sources', None) is not None:
                apps[node['id']] = node['data']['sources']
    return apps


