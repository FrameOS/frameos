# This file is autogenerated

import frameos/types
import tables
import scenes/scene_color as scene_color
import scenes/scene_gradient as scene_gradient
import scenes/scene_ifElse as scene_ifElse
import scenes/scene_image as scene_image
import scenes/scene_imageError as scene_imageError
import scenes/scene_qr as scene_qr
import scenes/scene_text as scene_text

let defaultSceneId* = "color".SceneId

const sceneOptions* = [
  ("color".SceneId, "Test Color"),
  ("gradient".SceneId, "Test Gradient"),
  ("ifElse".SceneId, "Test If Else"),
  ("image".SceneId, "TEST"),
  ("imageError".SceneId, "TEST"),
  ("qr".SceneId, "Test QR"),
  ("text".SceneId, "Text test"),
]

proc getExportedScenes*(): Table[SceneId, ExportedScene] =
  result = initTable[SceneId, ExportedScene]()
  result["color".SceneId] = scene_color.exportedScene
  result["gradient".SceneId] = scene_gradient.exportedScene
  result["ifElse".SceneId] = scene_ifElse.exportedScene
  result["image".SceneId] = scene_image.exportedScene
  result["imageError".SceneId] = scene_imageError.exportedScene
  result["qr".SceneId] = scene_qr.exportedScene
  result["text".SceneId] = scene_text.exportedScene