from typing import Dict, Optional, List
import json
import os


def get_app_configs() -> Dict[str, Dict]:
    local_apps_path = "../frameos/apps"
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


def get_one_app_sources(keyword: str) -> Optional[Dict[str, str]]:
    local_apps_path = "../frameos/apps"
    apps = os.listdir(local_apps_path)
    sources: Dict[str, str] = {}
    if keyword in apps:
        local_app_path = os.path.join(local_apps_path, keyword)
        app_path = os.path.join(local_app_path, "frame.py")
        if os.path.exists(app_path):
            with open(app_path, 'r') as f:
                sources['frame.py'] = f.read()
        config_path = os.path.join(local_app_path, "config.json")
        if os.path.exists(config_path):
            with open(config_path, 'r') as f:
                sources['config.json'] = f.read()
    return sources



def get_apps_from_scenes(scenes: List[Dict]) -> Dict[str, Dict]:
    apps = {}
    for scene in scenes:
        for node in scene.get('nodes', []):
            if node['type'] == 'app' and node.get('data', {}).get('sources', None) is not None:
                apps[node['id']] = node['data']['sources']
    return apps
