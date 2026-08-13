"""Rewrites scenes that still use the removed `legacy/*` apps.

The legacy apps (deprecated June 2024) were monolithic render-chain apps.
Each one is replaced by its modern equivalent:

- Image producers (downloadImage, frameOSGallery, localImage, openai,
  unsplash, qr) become a `render/image` node in the same spot of the render
  chain, fed by the matching `data/*` app through a fieldInput/image edge.
- `legacy/clock` becomes `render/text` fed by `data/clock`.
- State setters (haSensor, openaiText) become `logic/setAsState` fed by
  `data/haSensor` / `data/openaiText`.
- `legacy/resize` and `legacy/rotate` mutate the canvas mid-chain and have no
  modern counterpart, so their Nim source is inlined into the node
  (`data.sources`), turning them into self-contained edited apps.

`cacheSeconds`-style fields translate to the node-level cache config the new
data apps use. Field values are materialized explicitly (falling back to the
legacy defaults) so behavior stays identical even where the new apps ship
different defaults (e.g. data/localImage's path).

Nodes that already carry edited sources — on the node or via scene-level
`apps` — are left alone: they are self-contained and keep working without the
`legacy/` directory.
"""

import uuid

# Fixed namespace so re-running the transform yields the same ids.
_NAMESPACE = uuid.UUID("f3a5b1c7-4d2e-4f60-9a8b-1c2d3e4f5a6b")

_CLOCK_VALIGN = {"top": "top", "center": "middle", "bottom": "bottom"}
_CLOCK_HALIGN = {"left": "left", "center": "center", "right": "right"}

_LEGACY_DEFAULTS = {
    "legacy/clock": {
        "format": "HH:mm:ss", "formatCustom": "", "position": "center-center",
        "offsetX": "0", "offsetY": "0", "padding": "10", "fontColor": "#ffffff",
        "fontSize": "32", "borderColor": "#000000", "borderWidth": "2",
    },
    "legacy/downloadImage": {"url": "", "scalingMode": "cover", "cacheSeconds": "3600"},
    "legacy/frameOSGallery": {"category": "cute", "scalingMode": "cover", "cacheSeconds": "3600"},
    "legacy/haSensor": {"entityId": "", "stateKey": "sensor", "cacheSeconds": "60", "debug": "false"},
    "legacy/localImage": {
        "path": "/srv/images", "order": "random", "seconds": "900",
        "scalingMode": "cover", "counterStateKey": "",
    },
    "legacy/openai": {
        "prompt": "", "model": "gpt-image-2", "size": "best for orientation",
        "scalingMode": "cover", "style": "vivid", "quality": "standard", "cacheSeconds": "3600",
    },
    "legacy/openaiText": {
        "system": "You're a smart e-ink frame running FrameOS. Reply with plain text only. Space is very limited.",
        "user": "", "model": "gpt-5.5", "stateKey": "reply", "cacheSeconds": "3600",
    },
    "legacy/qr": {
        "codeType": "Frame Control URL", "code": "", "size": "2", "sizeUnit": "pixels per dot",
        "alRad": "30", "moRad": "0", "moSep": "0", "position": "center-center",
        "offsetX": "0", "offsetY": "0", "padding": "1",
        "qrCodeColor": "#000000", "backgroundColor": "#ffffff",
    },
    "legacy/unsplash": {"keyword": "nature", "cacheSeconds": "3600"},
    "legacy/resize": {},
    "legacy/rotate": {},
}

# Scenes that predate app categories used bare keywords; the frontend's
# sanitizeNodes used to rewrite these to legacy/* on load. Handle them here so
# that rewrite can go away with the legacy apps.
_LEGACY_ALIASES = {
    "clock": "legacy/clock",
    "downloadImage": "legacy/downloadImage",
    "frameOSGallery": "legacy/frameOSGallery",
    "haSensor": "legacy/haSensor",
    "localImage": "legacy/localImage",
    "openai": "legacy/openai",
    "openaiText": "legacy/openaiText",
    "qr": "legacy/qr",
    "resize": "legacy/resize",
    "rotate": "legacy/rotate",
    "unsplash": "legacy/unsplash",
}

# legacy/resize inlined verbatim, except `parseHtmlColor(self.frameConfig.color)`:
# FrameConfig lost its `color` field, so the legacy app no longer compiled at
# all. The fill now uses the scene background, like legacy/rotate always did.
_RESIZE_APP_NIM = '''import pixie
import frameos/types
import frameos/utils/image

type
  AppConfig* = object
    scalingMode*: string
    width*: int
    height*: int

  App* = ref object
    nodeId*: NodeId
    frameConfig*: FrameConfig
    scene*: FrameScene
    appConfig*: AppConfig

proc init*(nodeId: NodeId, scene: FrameScene, appConfig: AppConfig): App =
  result = App(
    nodeId: nodeId,
    scene: scene,
    frameConfig: scene.frameConfig,
    appConfig: appConfig,
  )

proc run*(self: App, context: ExecutionContext) =
  let image = newImage(self.appConfig.width, self.appConfig.height)
  case self.appConfig.scalingMode:
    of "center", "contain", "":
      image.fill(self.scene.backgroundColor)
  image.scaleAndDrawImage(context.image, self.appConfig.scalingMode)
  context.image = image
'''

_RESIZE_CONFIG_JSON = '''{
  "name": "Resize (legacy)",
  "description": "Scale or stretch the image",
  "category": "render",
  "version": "1.0.0",
  "fields": [
    { "name": "width", "type": "integer", "required": true, "label": "New Width", "placeholder": "e.g., 1024" },
    { "name": "height", "type": "integer", "required": true, "label": "New Height", "placeholder": "e.g., 1024" },
    {
      "name": "scalingMode",
      "type": "select",
      "options": ["cover", "contain", "stretch", "center"],
      "value": "contain",
      "required": true,
      "label": "Scaling mode"
    }
  ]
}
'''

_ROTATE_APP_NIM = '''import pixie
import json
import strformat
import frameos/types
import frameos/utils/image

type
  AppConfig* = object
    rotationDegree*: float
    scalingMode*: string

  App* = ref object
    nodeId*: NodeId
    scene*: FrameScene
    frameConfig*: FrameConfig
    appConfig*: AppConfig

proc init*(nodeId: NodeId, scene: FrameScene, appConfig: AppConfig): App =
  result = App(
    nodeId: nodeId,
    scene: scene,
    frameConfig: scene.frameConfig,
    appConfig: appConfig,
  )

proc log*(self: App, message: string) =
  self.scene.logger.log(%*{"event": &"{self.nodeId}:log", "message": message})

proc run*(self: App, context: ExecutionContext) =
  let originalImage = context.image
  let rotationAngle = degToRad(self.appConfig.rotationDegree).float32

  # Calculate the new dimensions after rotation
  let cosAngle = abs(cos(rotationAngle))
  let sinAngle = abs(sin(rotationAngle))
  let newWidth = int(ceil(originalImage.width.float32 * cosAngle +
      originalImage.height.float32 * sinAngle))
  let newHeight = int(ceil(originalImage.width.float32 * sinAngle +
      originalImage.height.float32 * cosAngle))

  # Create a new target image with the calculated dimensions
  let targetImage = newImage(newWidth, newHeight)
  targetImage.fill(self.scene.backgroundColor)

  # Calculate the center of the original and target images
  let originalCenterX = originalImage.width.float32 / 2
  let originalCenterY = originalImage.height.float32 / 2
  let targetCenterX = newWidth.float32 / 2
  let targetCenterY = newHeight.float32 / 2

  # Create a transformation that translates the image to the center of the target image, rotates it, and then translates it back
  let transform =
    translate(vec2(targetCenterX, targetCenterY)) *
    rotate(rotationAngle) *
    translate(vec2(-originalCenterX, -originalCenterY))

  targetImage.draw(
    originalImage,
    transform,
    OverwriteBlend
  )

  if self.appConfig.scalingMode == "expand":
    context.image = targetImage
  else:
    context.image.scaleAndDrawImage(targetImage, self.appConfig.scalingMode)
'''

_ROTATE_CONFIG_JSON = '''{
  "name": "Rotate (legacy)",
  "description": "Rotate the image",
  "category": "render",
  "version": "1.0.0",
  "fields": [
    {
      "name": "rotationDegree",
      "type": "float",
      "value": "0",
      "required": true,
      "label": "Rotation Degree",
      "placeholder": "e.g., 45"
    },
    {
      "name": "scalingMode",
      "type": "select",
      "options": ["expand", "cover", "contain", "stretch", "center"],
      "value": "cover",
      "required": true,
      "label": "Scaling mode"
    }
  ]
}
'''

_INLINE_SOURCES = {
    "legacy/resize": {"app.nim": _RESIZE_APP_NIM, "config.json": _RESIZE_CONFIG_JSON},
    "legacy/rotate": {"app.nim": _ROTATE_APP_NIM, "config.json": _ROTATE_CONFIG_JSON},
}


def _det_id(node_id: str, suffix: str) -> str:
    return str(uuid.uuid5(_NAMESPACE, f"legacy-app-migration:{node_id}:{suffix}"))


def _seconds(value) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _cache_config(cache_seconds) -> dict | None:
    if _seconds(cache_seconds) > 0:
        return {
            "enabled": True,
            "inputEnabled": True,
            "durationEnabled": True,
            "duration": str(cache_seconds),
        }
    return None


def _data_node(node: dict, keyword: str, config: dict, cache_seconds=None) -> dict:
    position = node.get("position") or {}
    data: dict = {"keyword": keyword, "config": config}
    cache = _cache_config(cache_seconds)
    if cache:
        data["cache"] = cache
    return {
        "id": _det_id(node["id"], "data-node"),
        "type": "app",
        "position": {"x": position.get("x", 0), "y": position.get("y", 0) - 220},
        "data": data,
    }


def _field_edge(source_id: str, target_id: str, field: str) -> dict:
    return {
        "id": _det_id(target_id, f"edge-{field}"),
        "source": source_id,
        "sourceHandle": "fieldOutput",
        "target": target_id,
        "targetHandle": f"fieldInput/{field}",
    }


def _qr_placement(position: str) -> str:
    return "center" if position == "center-center" else position


def _migrate_node(node: dict, config: dict) -> tuple[list[dict], list[dict]]:
    """Mutates `node` in place; returns (new_nodes, new_edges)."""
    keyword = node["data"]["keyword"]
    node_id = node["id"]

    if keyword in _INLINE_SOURCES:
        node["data"]["sources"] = dict(_INLINE_SOURCES[keyword])
        return [], []

    if keyword == "legacy/clock":
        v, _, h = config["position"].partition("-")
        node["data"]["keyword"] = "render/text"
        node["data"]["config"] = {
            "position": _CLOCK_HALIGN.get(h, "center"),
            "vAlign": _CLOCK_VALIGN.get(v, "middle"),
            "offsetX": config["offsetX"],
            "offsetY": config["offsetY"],
            "padding": config["padding"],
            "fontColor": config["fontColor"],
            "fontSize": config["fontSize"],
            "borderColor": config["borderColor"],
            "borderWidth": config["borderWidth"],
            "overflow": "visible",
        }
        data_node = _data_node(node, "data/clock", {
            "format": config["format"],
            "formatCustom": config["formatCustom"],
        })
        return [data_node], [_field_edge(data_node["id"], node_id, "text")]

    if keyword == "legacy/haSensor":
        state_key = config["stateKey"] or "state"
        node["data"]["keyword"] = "logic/setAsState"
        node["data"]["config"] = {"stateKey": state_key}
        data_node = _data_node(node, "data/haSensor", {
            "entityId": config["entityId"],
            "debug": config["debug"],
        }, config["cacheSeconds"])
        return [data_node], [_field_edge(data_node["id"], node_id, "valueJson")]

    if keyword == "legacy/openaiText":
        node["data"]["keyword"] = "logic/setAsState"
        node["data"]["config"] = {"stateKey": config["stateKey"]}
        data_node = _data_node(node, "data/openaiText", {
            "system": config["system"],
            "user": config["user"],
            "model": config["model"],
        }, config["cacheSeconds"])
        return [data_node], [_field_edge(data_node["id"], node_id, "valueString")]

    # The rest all become render/image + an image-producing data app.
    render_config: dict = {}
    if keyword == "legacy/downloadImage":
        render_config["placement"] = config["scalingMode"]
        data_node = _data_node(node, "data/downloadImage", {"url": config["url"]}, config["cacheSeconds"])
    elif keyword == "legacy/frameOSGallery":
        render_config["placement"] = config["scalingMode"]
        data_node = _data_node(node, "data/frameOSGallery", {"category": config["category"]}, config["cacheSeconds"])
    elif keyword == "legacy/localImage":
        render_config["placement"] = config["scalingMode"]
        data_node = _data_node(node, "data/localImage", {
            "path": config["path"],
            "order": config["order"],
            "counterStateKey": config["counterStateKey"],
        }, config["seconds"])
    elif keyword == "legacy/openai":
        render_config["placement"] = config["scalingMode"]
        data_node = _data_node(node, "data/openaiImage", {
            "prompt": config["prompt"],
            "model": config["model"],
            "size": config["size"],
            "style": config["style"],
            "quality": config["quality"],
        }, config["cacheSeconds"])
    elif keyword == "legacy/unsplash":
        render_config["placement"] = "cover"
        data_node = _data_node(node, "data/unsplash", {"search": config["keyword"]}, config["cacheSeconds"])
    elif keyword == "legacy/qr":
        render_config["placement"] = _qr_placement(config["position"])
        render_config["offsetX"] = config["offsetX"]
        render_config["offsetY"] = config["offsetY"]
        data_node = _data_node(node, "data/qr", {
            "codeType": config["codeType"],
            "code": config["code"],
            "size": config["size"],
            "sizeUnit": config["sizeUnit"],
            "alRad": config["alRad"],
            "moRad": config["moRad"],
            "moSep": config["moSep"],
            "padding": config["padding"],
            "qrCodeColor": config["qrCodeColor"],
            "backgroundColor": config["backgroundColor"],
        })
    else:
        return [], []

    node["data"]["keyword"] = "render/image"
    node["data"]["config"] = render_config
    return [data_node], [_field_edge(data_node["id"], node_id, "image")]


def migrate_legacy_apps_in_scene(scene: dict) -> bool:
    """Replaces legacy/* app nodes in a scene. Mutates the scene, returns True if changed."""
    if not isinstance(scene, dict):
        return False
    nodes = scene.get("nodes")
    if not isinstance(nodes, list):
        return False
    scene_apps = scene.get("apps") if isinstance(scene.get("apps"), dict) else {}

    changed = False
    new_nodes: list[dict] = []
    new_edges: list[dict] = []
    for node in nodes:
        if not isinstance(node, dict) or node.get("type") != "app" or not node.get("id"):
            continue
        data = node.get("data")
        if not isinstance(data, dict):
            continue
        original_keyword = data.get("keyword", "")
        if not isinstance(original_keyword, str):
            continue
        keyword = _LEGACY_ALIASES.get(original_keyword, original_keyword)
        if keyword not in _LEGACY_DEFAULTS:
            continue
        sources = data.get("sources")
        if isinstance(sources, dict) and len(sources) > 0:
            continue  # edited app: self-contained, keeps working as nodeapp_<id>
        scene_app = scene_apps.get(original_keyword) or scene_apps.get(keyword)
        if isinstance(scene_app, dict) and scene_app.get("sources"):
            continue  # scene-level edited app: deployed from scene sources
        data["keyword"] = keyword
        node_config = data.get("config") if isinstance(data.get("config"), dict) else {}
        config = {**_LEGACY_DEFAULTS[keyword], **node_config}
        added_nodes, added_edges = _migrate_node(node, config)
        new_nodes += added_nodes
        new_edges += added_edges
        changed = True

    if changed:
        nodes.extend(new_nodes)
        if new_edges:
            edges = scene.get("edges")
            if not isinstance(edges, list):
                edges = []
                scene["edges"] = edges
            edges.extend(new_edges)
    return changed


def migrate_legacy_apps_in_scenes(scenes) -> bool:
    """Applies the transform to a list of scenes. Returns True if any changed."""
    if not isinstance(scenes, list):
        return False
    changed = False
    for scene in scenes:
        changed = migrate_legacy_apps_in_scene(scene) or changed
    return changed
