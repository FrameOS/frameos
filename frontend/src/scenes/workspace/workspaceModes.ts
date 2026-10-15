export type WorkspaceMode = 'home' | 'frames' | 'frame' | 'scenes' | 'apps' | 'photos' | 'settings'

export function workspaceModeForScene(scene: string | null | undefined): WorkspaceMode | null {
  if (scene === 'home') {
    return 'home'
  }
  if (scene === 'frames') {
    return 'frames'
  }
  if (scene === 'frame') {
    return 'frame'
  }
  if (scene === 'sceneWorkspace') {
    return 'scenes'
  }
  if (scene === 'appsWorkspace') {
    return 'apps'
  }
  if (scene === 'photosWorkspace') {
    return 'photos'
  }
  if (scene === 'settings') {
    return 'settings'
  }
  return null
}

export function workspaceModeForSceneOrFrames(scene: string | null | undefined): WorkspaceMode {
  return workspaceModeForScene(scene) ?? 'frames'
}
