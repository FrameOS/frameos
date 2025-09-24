import json
from typing import Optional
import os

def write_app_loader_nim(app_dir, config: Optional[dict] = None) -> str:
    if not config:
        config_path = os.path.join(app_dir, "config.json")
        if not os.path.exists(config_path):
            raise FileNotFoundError(f"Config file not found: {config_path}")
        with open(config_path, "r") as f:
            config = json.load(f)
            assert config is not None

    print(config)
    # {'name': 'Next sleep duration',
    # 'description': 'Override the delay between renders',
    # 'category': 'logic',
    # 'version': '1.0.0',
    # 'fields': [{'name': 'duration', 'type': 'float', 'required': True, 'label': 'Duration in seconds'}]}

    app_config_lines = []
    fields = config.get('fields', [])
    for field in fields:
        if field.get('markdown'):
            continue
        field_name = field['name']
        field_type = field['type']
        nim_field_name = field_name.replace(" ", "_").lower()
        if field_type == 'string' or field_type == 'text' or field_type == 'select':
            nim_type = 'string'
            default_value = '""'
        elif field_type == 'integer':
            nim_type = 'int'
            default_value = '0'
        elif field_type == 'float':
            nim_type = 'float'
            default_value = '0.0'
        elif field_type == 'boolean':
            nim_type = 'bool'
            default_value = 'false'
        elif field_type == 'image':
            nim_type = 'Option[Image]'
            default_value = 'none(Image)'
        elif field_type == 'node':
            nim_type = 'Option[Node]'
            default_value = 'none(Node)'
        elif field_type == 'json':
            nim_type = 'Value'
            default_value = 'newJObject()'
        elif field_type == 'color':
            nim_type = 'Color'
            default_value = 'Color(0, 0, 0, 0)'
        elif field_type == 'font':
            nim_type = 'Font'
            default_value = 'nil'
        else:
            raise ValueError(f"Unsupported field type: {field_type}")
        app_config_lines.append(f"        {nim_field_name}*: {nim_type} = {default_value}")

    newline = os.linesep
    nim_code = f"""import json
import os
import tables
import frameos/values
import frameos/types
import ./app as app_module

proc init(params: Table[string, Value]): AppRoot =
  let config = app_module.AppConfig(
{newline.join(app_config_lines)}
  )
  result = AppRoot(
    appConfig: config
  )
  let app = app_module.App(config)

proc run(self: AppRoot, context: ExecutionContext) =
  app.run(context)

proc get(self: AppRoot, context: ExecutionContext): Value =
  return app.get(context)
"""
    return nim_code
