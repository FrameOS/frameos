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
    app_set_lines = []
    fields = config.get('fields', [])
    for field in fields:
        if field.get('markdown'):
            continue
        field_name = field['name'] ## TODO: sanitize!
        field_type = field['type']
        field_default = field.get('value')
        field_required = field.get('required', False)

        if field_type == 'string' or field_type == 'text' or field_type == 'select' or field_type == 'font':
            nim_type = 'string'
            to_field_type = 'getStr'
            as_field_type = 'asString'
            default_value = '"' + field_default + '"' if field_default is not None else '""' # TODO: escape!
        elif field_type == 'integer':
            nim_type = 'int'
            to_field_type = 'getInt'
            as_field_type = 'asInt'
            default_value = field_default if field_default is not None else '0' # TODO: ESCAPE!
        elif field_type == 'float':
            nim_type = 'float'
            to_field_type = 'getFloat'
            as_field_type = 'asFloat'
            default_value = field_default if field_default is not None else '0.0' # TODO: ESCAPE!
        elif field_type == 'boolean':
            nim_type = 'bool'
            to_field_type = 'getBool'
            default_value = 'true' if field_default else 'false'
            as_field_type = 'asBool'
        elif field_type == 'image':
            nim_type = 'Option[Image]'
            to_field_type = None
            default_value = 'none(Image)'
            as_field_type = 'asImage'

            if field_required:
                nim_type = 'Image'
                default_value = 'newImage(1,1)'
                as_field_type = 'asImage'
        elif field_type == 'node':
            nim_type = 'NodeId'
            to_field_type = 'getFloat'
            default_value = '0'
            as_field_type = 'asNode'
        elif field_type == 'json':
            nim_type = 'JsonNode'
            to_field_type = ''
            default_value = 'newJObject()'
            as_field_type = 'asJson'
        elif field_type == 'color':
            nim_type = 'Color'
            to_field_type = 'getStr'
            default_value = '"' + field_default + '"' if field_default is not None else '"#000000"' # TODO: escape!
            as_field_type = 'asColor'
        else:
            raise ValueError(f"Unsupported field type: {field_type}")

        if to_field_type is None:
            field_getter = default_value
        elif to_field_type == '':
            field_getter = f"params{{\"{field_name}\"}}"
        else:
            field_getter = f"params{{\"{field_name}\"}}.{to_field_type}({default_value})"

        if nim_type == 'Color':
            field_getter = f"parseHtmlColor({field_getter})"
        elif nim_type == 'NodeId':
            field_getter = f"{field_getter}.NodeId"

        app_config_lines.append(f"    {field_name}: {field_getter},")
        app_set_lines.append(f'  of "{field_name}":')

        if not field_required and field_type in ('image'):
            app_set_lines.append(f'    app.appConfig.{field_name} = if value.kind == fkImage: some(value.{as_field_type}()) else: none(Image)')
        else:
            app_set_lines.append(f'    app.appConfig.{field_name} = value.{as_field_type}()')

    newline = os.linesep
    nim_code = f"""import json
import options
import pixie
import frameos/values
import frameos/types
import ./app as app_module

proc init*(
    node: DiagramNode,
    scene: FrameScene,
): AppRoot =
  let params = node.data["config"]
  if params.kind != JObject:
    raise newException(Exception, "Invalid config format")
  let config = app_module.AppConfig(
{newline.join(app_config_lines)}
  )

  result = app_module.App(
    appConfig: config,
    nodeName: node.data{{"name"}}.getStr(),
    nodeId: node.id,
    scene: scene,
    frameConfig: scene.frameConfig,
  )

proc setField*(self: AppRoot, field: string, value: Value) =
  let app = app_module.App(self)
  case field:
{newline.join(app_set_lines)}
  else:
    raise newException(ValueError, "Unknown field: " & field)

proc run*(self: AppRoot, context: ExecutionContext) =
  self.run(context)

proc get*(self: AppRoot, context: ExecutionContext): Value =
  return self.get(context)
"""
    return nim_code
