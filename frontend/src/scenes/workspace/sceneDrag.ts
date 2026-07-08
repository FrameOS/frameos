import type { RepositoryType, TemplateType } from '../../types'

export const FRAMEOS_SCENE_DRAG_TYPE = 'application/x-frameos-scene-id'
export const FRAMEOS_TEMPLATE_DRAG_TYPE = 'application/x-frameos-template'
export const FRAMEOS_SPLIT_LEAF_DRAG_TYPE = 'application/x-frameos-split-leaf'

export interface FrameosTemplateDragData {
  template: TemplateType
  repository?: RepositoryType
}

export function setFrameosSceneDragData(dataTransfer: DataTransfer, sceneId: string): void {
  dataTransfer.effectAllowed = 'copyMove'
  dataTransfer.setData(FRAMEOS_SCENE_DRAG_TYPE, sceneId)
  dataTransfer.setData('text/plain', `frameos-scene:${sceneId}`)
}

export function getFrameosSceneDragData(dataTransfer: DataTransfer): string | null {
  const sceneId = dataTransfer.getData(FRAMEOS_SCENE_DRAG_TYPE)
  if (sceneId) {
    return sceneId
  }

  const plainText = dataTransfer.getData('text/plain')
  return plainText.startsWith('frameos-scene:') ? plainText.slice('frameos-scene:'.length) : null
}

export function hasFrameosSceneDragData(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(FRAMEOS_SCENE_DRAG_TYPE)
}

// Drag data for moving a scene between split-screen cells. Carries the source leaf id so a
// drop onto another cell can swap their contents. The scene id is included as well so plain
// scene drop targets keep working.
export function setFrameosSplitLeafDragData(
  dataTransfer: DataTransfer,
  leafId: string,
  sceneId?: string | null
): void {
  dataTransfer.effectAllowed = 'copyMove'
  dataTransfer.setData(FRAMEOS_SPLIT_LEAF_DRAG_TYPE, leafId)
  if (sceneId) {
    dataTransfer.setData(FRAMEOS_SCENE_DRAG_TYPE, sceneId)
  }
  dataTransfer.setData('text/plain', `frameos-split-leaf:${leafId}`)
}

export function getFrameosSplitLeafDragData(dataTransfer: DataTransfer): string | null {
  const leafId = dataTransfer.getData(FRAMEOS_SPLIT_LEAF_DRAG_TYPE)
  if (leafId) {
    return leafId
  }

  const plainText = dataTransfer.getData('text/plain')
  return plainText.startsWith('frameos-split-leaf:') ? plainText.slice('frameos-split-leaf:'.length) : null
}

export function setFrameosTemplateDragData(dataTransfer: DataTransfer, dragData: FrameosTemplateDragData): void {
  dataTransfer.effectAllowed = 'copy'
  dataTransfer.setData(FRAMEOS_TEMPLATE_DRAG_TYPE, JSON.stringify(dragData))
  dataTransfer.setData('text/plain', `frameos-template:${dragData.template.name}`)
}

export function getFrameosTemplateDragData(dataTransfer: DataTransfer): FrameosTemplateDragData | null {
  const rawDragData = dataTransfer.getData(FRAMEOS_TEMPLATE_DRAG_TYPE)
  if (!rawDragData) {
    return null
  }

  try {
    const dragData = JSON.parse(rawDragData) as FrameosTemplateDragData
    return dragData?.template?.name ? dragData : null
  } catch {
    return null
  }
}

export function hasFrameosSceneListDragData(dataTransfer: DataTransfer): boolean {
  const types = Array.from(dataTransfer.types)
  return types.includes(FRAMEOS_SCENE_DRAG_TYPE) || types.includes(FRAMEOS_TEMPLATE_DRAG_TYPE)
}
