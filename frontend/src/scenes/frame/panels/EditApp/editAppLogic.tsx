import { actions, afterMount, kea, key, path, props, reducers } from 'kea'

import type { editAppLogicType } from './editAppLogicType'
import { loaders } from 'kea-loaders'

export interface EditAppLogicProps {
  frameId: number
  sceneId: string
  nodeId: string
  keyword: string
  sources?: Record<string, string>
}

export const editAppLogic = kea<editAppLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'EditApp', 'editAppLogic']),
  props({} as EditAppLogicProps),
  key((props) => `${props.frameId}:${props.sceneId}.${props.nodeId}.${props.keyword}`),
  actions({ setActiveFile: (file: string) => ({ file }) }),
  loaders(({ props, values }) => ({
    sources: [
      props.sources || ({} as Record<string, string>),
      {
        loadSources: async () => {
          if (!props.keyword) return values.sources
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
  afterMount(({ actions, props }) => {
    if (props.keyword) {
      actions.loadSources()
    }
  }),
])
