import type { WorkspaceMode } from './workspaceSurfaces'

// The scene control drawer's "you have changes" notice, as pure data so the
// cloud app's node test suite can pin the per-mode copy and buttons
// (workspace-surfaces.test.ts pattern; this module must stay React-free).
//
// Backend/frameAdmin keep the save/deploy split: Save persists the form on
// the backend, Deploy rebuilds over SSH. The cloud has no scene "save" at all
// — its settings push carries no scene graphs, and its deploy is one durable
// set_scenes push through the uploadScenes shim — so the cloud copy offers a
// single "Deploy to frame" action and never mentions saving.

export interface SceneControlNoticeContent {
  statusText: string
  /** Offer a separate "Save changes" button (backend/frameAdmin only). */
  showSaveButton: boolean
  deployLabel: string
}

export function sceneControlNoticeContent({
  mode,
  sceneIsUnsaved,
  sceneIsUndeployed,
}: {
  mode: WorkspaceMode
  sceneIsUnsaved: boolean
  sceneIsUndeployed: boolean
}): SceneControlNoticeContent | null {
  if (!sceneIsUnsaved && !sceneIsUndeployed) {
    return null
  }

  if (mode === 'cloud') {
    return {
      statusText: 'This scene has changes that are not on the frame yet.',
      showSaveButton: false,
      deployLabel: 'Deploy to frame',
    }
  }

  return {
    statusText: sceneIsUnsaved
      ? sceneIsUndeployed
        ? 'This scene has unsaved changes that are not deployed to the frame.'
        : 'This scene has unsaved changes.'
      : 'This scene is saved but not deployed to the frame.',
    showSaveButton: sceneIsUnsaved,
    deployLabel: sceneIsUnsaved ? 'Save & deploy' : 'Deploy changes',
  }
}
