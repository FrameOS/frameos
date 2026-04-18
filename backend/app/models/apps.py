import json
import os
from app.utils.js_apps import COMPILED_JS_APP_FILENAME, find_js_app_source_filename

local_apps_path = "../frameos/src/apps"

def get_app_configs() -> dict[str, dict]:
    configs = {}
    for category in os.listdir(local_apps_path):
        category_app_path = os.path.join(local_apps_path, category)
        if os.path.isdir(category_app_path):
            for keyword in os.listdir(category_app_path):
                local_app_path = os.path.join(category_app_path, keyword)
                if os.path.isdir(local_app_path):
                    config_path = os.path.join(local_app_path, "config.json")
                    if os.path.exists(config_path):
                        try:
                            with open(config_path, 'r') as f:
                                config = json.load(f)
                                if 'name' in config:
                                    configs[category + '/' + keyword] = config
                        except Exception as e:
                            print(f"Error loading config for {category}/{keyword}: {e}")
    return configs


def get_local_frame_apps() -> list[str]:
    clean_apps: list[str] = []
    for category in os.listdir(local_apps_path):
        category_app_path = os.path.join(local_apps_path, category)
        if os.path.isdir(category_app_path):
            apps = os.listdir(category_app_path)
            for keyword in apps:
                local_app_path = os.path.join(category_app_path, keyword)
                config_path = os.path.join(local_app_path, "config.json")
                has_source = os.path.exists(os.path.join(local_app_path, "app.nim")) or find_js_app_source_filename(local_app_path)
                if has_source and os.path.exists(config_path):
                    clean_apps.append(category + '/' + keyword)
    return clean_apps



def get_one_app_sources(keyword: str) -> dict[str, str]:
    sources: dict[str, str] = {}
    apps = get_local_frame_apps()
    if keyword in apps:
        local_app_path = os.path.join(local_apps_path, keyword)
        has_js_source = find_js_app_source_filename(local_app_path) is not None
        files = os.listdir(local_app_path)
        for file in files:
            if file == "app_loader.nim":
                continue
            if file == COMPILED_JS_APP_FILENAME:
                continue
            if has_js_source and file == "app.nim":
                continue
            full_path = os.path.join(local_app_path, file)
            if os.path.isfile(full_path):
                # TODO: also support folders and binary files
                with open(full_path, 'r') as f:
                    sources[file] = f.read()
    return sources


def get_apps_from_scenes(scenes: list[dict]) -> dict[str, dict]:
    apps = {}
    for scene in scenes:
        for node in scene.get('nodes', []):
            if node['type'] == 'app' and node.get('data', {}).get('sources', None) is not None:
                apps[node['id']] = node['data']['sources']
    return apps
