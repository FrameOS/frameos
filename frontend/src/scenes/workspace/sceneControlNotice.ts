import type { WorkspaceMode } from './workspaceSurfaces'

// The scene control drawer's "you have changes" notice, as pure data so the
// cloud app's node test suite can pin the per-mode copy and buttons
// (workspace-surfaces.test.ts pattern; this module must stay React-free).
//
// docs/ui-vocabulary.md: scenes are pushed, FrameOS and settings deployed.
// The backend keeps the save/push split: Save persists the form, Push sends
// this scene and its changed connected scenes (utils/scenePush.ts). The
// cloud has no scene "save" at all, so it offers the push alone and never
// mentions saving. On the device (frameAdmin) Save is the whole story: there
// is nowhere to push to. On the active scene the drawer's main action is the
// push already ("Push to frame"), so the notice does not offer it twice.

export interface SceneControlNoticeContent {
  statusText: string
  /** Offer a separate "Save changes" button (backend/frameAdmin only). */
  showSaveButton: boolean
  /** The push button, which leaves the active scene as it is; null for none. */
  pushLabel: string | null
}

export function sceneControlNoticeContent({
  mode,
  sceneIsUnsaved,
  sceneIsUndeployed,
  sceneIsActive,
}: {
  mode: WorkspaceMode
  sceneIsUnsaved: boolean
  sceneIsUndeployed: boolean
  sceneIsActive: boolean
}): SceneControlNoticeContent | null {
  if (!sceneIsUnsaved && !sceneIsUndeployed) {
    return null
  }

  if (mode === 'cloud') {
    return {
      statusText: 'This scene has changes that are not on the frame yet.',
      showSaveButton: false,
      pushLabel: sceneIsActive ? null : 'Push to frame',
    }
  }

  if (mode === 'frameAdmin') {
    return {
      statusText: 'This scene has unsaved changes.',
      showSaveButton: true,
      pushLabel: null,
    }
  }

  return {
    statusText: sceneIsUnsaved
      ? sceneIsUndeployed
        ? 'This scene has unsaved changes that are not on the frame yet.'
        : 'This scene has unsaved changes.'
      : 'This scene is saved but not on the frame yet.',
    showSaveButton: sceneIsUnsaved,
    pushLabel: sceneIsActive ? null : sceneIsUnsaved ? 'Save & push' : 'Push to frame',
  }
}
