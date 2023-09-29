import { actions, afterMount, kea, key, path, reducers } from 'kea'

import type { editAppLogicType } from './editAppLogicType'
import { loaders } from 'kea-loaders'

export const editAppLogic = kea<editAppLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'EditApp', 'editAppLogic']),
  key((props) => `${props.frameId}/${props.keyword}`),
  actions({ setActiveFile: (file: string) => ({ file }) }),
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
    activeFile: [
      'frame.py' as string,
      {
        setActiveFile: (state, { file }) => file,
      },
    ],
  }),
  afterMount(({ actions }) => {
    actions.loadSources()
  }),
])
