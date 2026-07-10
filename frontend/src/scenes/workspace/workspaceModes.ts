export type WorkspaceMode = 'frames' | 'frame' | 'scenes' | 'apps' | 'settings'

export function workspaceModeForScene(scene: string | null | undefined): WorkspaceMode | null {
  if (scene === 'frames') {
    return 'frames'
  }
  if (scene === 'frame') {
    return 'frame'
  }
  if (scene === 'sceneWorkspace' || scene === 'scenesOverview') {
    return 'scenes'
  }
  if (scene === 'appsWorkspace') {
    return 'apps'
  }
  if (scene === 'settings') {
    return 'settings'
  }
  return null
}

export function workspaceModeForSceneOrFrames(scene: string | null | undefined): WorkspaceMode {
  return workspaceModeForScene(scene) ?? 'frames'
}
