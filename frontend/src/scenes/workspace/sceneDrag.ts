export const FRAMEOS_SCENE_DRAG_TYPE = 'application/x-frameos-scene-id'

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
