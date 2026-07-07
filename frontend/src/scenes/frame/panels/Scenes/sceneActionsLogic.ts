import { actions, kea, path, reducers } from 'kea'

import type { sceneActionsLogicType } from './sceneActionsLogicType'

/** Which action the scene split-button performs when clicked. */
export type SceneActionKey = 'activate' | 'preview-frame' | 'preview-browser'

/**
 * Global, persisted preference for the scene action split-button: picking an
 * option from the dropdown runs it and makes it the default everywhere.
 * `null` means the user hasn't picked yet — each context supplies its own
 * default (matching what the old standalone buttons did).
 */
export const sceneActionsLogic = kea<sceneActionsLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Scenes', 'sceneActionsLogic']),
  actions({
    setPreferredSceneAction: (action: SceneActionKey) => ({ action }),
  }),
  reducers({
    preferredSceneAction: [
      null as SceneActionKey | null,
      { persist: true, storageKey: 'scenes.preferredSceneAction' },
      {
        setPreferredSceneAction: (_, { action }) => action,
      },
    ],
  }),
])
