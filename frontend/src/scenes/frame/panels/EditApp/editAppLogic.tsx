import { actions, afterMount, kea, key, path, reducers } from 'kea'

import type { editAppLogicType } from './editAppLogicType'
import { loaders } from 'kea-loaders'

export const editAppLogic = kea<editAppLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'EditApp', 'editAppLogic']),
  key((props) => `${props.frameId}/${props.keyword}`),
  actions({ toggleFile: (file: string) => ({ file }) }),
  loaders(({ props }) => ({
    sources: [
      {} as Record<string, string>,
      {
        loadSources: async () => {
          const response = await fetch(`/api/apps/source/${encodeURIComponent(props.keyword as string)}`)
          return await response.json()
        },
      },
    ],
  })),
  reducers({
    openFiles: [
      ['frame.py'] as string[],
      {
        toggleFile: (state, { file }) => {
          if (state.includes(file)) {
            return state.filter((f) => f !== file)
          } else {
            return [...state, file]
          }
        },
      },
    ],
  }),
  afterMount(({ actions }) => {
    actions.loadSources()
  }),
])
