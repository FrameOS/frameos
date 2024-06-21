# This file is autogenerated

import frameos/types
import tables, options
import scenes/scene_dataDownloadImage as scene_dataDownloadImage
import scenes/scene_dataDownloadUrl as scene_dataDownloadUrl
import scenes/scene_dataLocalImage as scene_dataLocalImage
import scenes/scene_dataNewImage as scene_dataNewImage
import scenes/scene_renderColorFlow as scene_renderColorFlow
import scenes/scene_renderColorImage as scene_renderColorImage
import scenes/scene_renderColorSplit as scene_renderColorSplit
import scenes/scene_renderGradientSplit as scene_renderGradientSplit
import scenes/scene_renderImage as scene_renderImage
import scenes/scene_renderSplitData as scene_renderSplitData
import scenes/scene_renderSplitFlow as scene_renderSplitFlow
import scenes/scene_renderSplitLoop as scene_renderSplitLoop
import scenes/scene_renderTextOverflow as scene_renderTextOverflow
import scenes/scene_renderTextPosition as scene_renderTextPosition
import scenes/scene_renderTextSplit as scene_renderTextSplit

let defaultSceneId* = some("dataDownloadImage".SceneId)

const sceneOptions* = [
  ("dataDownloadImage".SceneId, "Download Image"),
  ("dataDownloadUrl".SceneId, "Download URL"),
  ("dataLocalImage".SceneId, "Local Image"),
  ("dataNewImage".SceneId, "New Image"),
  ("renderColorFlow".SceneId, "Color"),
  ("renderColorImage".SceneId, "Color"),
  ("renderColorSplit".SceneId, "Color"),
  ("renderGradientSplit".SceneId, "Gradient"),
  ("renderImage".SceneId, "Render image"),
  ("renderSplitData".SceneId, "Split"),
  ("renderSplitFlow".SceneId, "Split"),
  ("renderSplitLoop".SceneId, "Split Loop"),
  ("renderTextOverflow".SceneId, "Text Overflow"),
  ("renderTextPosition".SceneId, "Text"),
  ("renderTextSplit".SceneId, "Text Split"),
]

proc getExportedScenes*(): Table[SceneId, ExportedScene] =
  result = initTable[SceneId, ExportedScene]()
  result["dataDownloadImage".SceneId] = scene_dataDownloadImage.exportedScene
  result["dataDownloadUrl".SceneId] = scene_dataDownloadUrl.exportedScene
  result["dataLocalImage".SceneId] = scene_dataLocalImage.exportedScene
  result["dataNewImage".SceneId] = scene_dataNewImage.exportedScene
  result["renderColorFlow".SceneId] = scene_renderColorFlow.exportedScene
  result["renderColorImage".SceneId] = scene_renderColorImage.exportedScene
  result["renderColorSplit".SceneId] = scene_renderColorSplit.exportedScene
  result["renderGradientSplit".SceneId] = scene_renderGradientSplit.exportedScene
  result["renderImage".SceneId] = scene_renderImage.exportedScene
  result["renderSplitData".SceneId] = scene_renderSplitData.exportedScene
  result["renderSplitFlow".SceneId] = scene_renderSplitFlow.exportedScene
  result["renderSplitLoop".SceneId] = scene_renderSplitLoop.exportedScene
  result["renderTextOverflow".SceneId] = scene_renderTextOverflow.exportedScene
  result["renderTextPosition".SceneId] = scene_renderTextPosition.exportedScene
  result["renderTextSplit".SceneId] = scene_renderTextSplit.exportedScene
