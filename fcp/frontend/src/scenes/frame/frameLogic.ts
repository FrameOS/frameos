import { actions, afterMount, kea, key, path, props, selectors } from 'kea'

import type { frameLogicType } from './frameLogicType'
import { FrameType, LogType } from '../../types'
import { loaders } from 'kea-loaders'

export interface FrameLogicProps {
  id: number
}

export const frameLogic = kea<frameLogicType>([
  path(['src', 'scenes', 'frame', 'frameLogic']),
  props({} as FrameLogicProps),
  key((props) => props.id),

  loaders(({ props }) => ({
    frame: [
      null as FrameType | null,
      {
        loadFrame: async () => {
          try {
            const response = await fetch(`/api/frames/${props.id}`)
            if (!response.ok) {
              throw new Error('Failed to fetch logs')
            }
            const data = await response.json()
            return data.frame as FrameType
          } catch (error) {
            console.error(error)
            return null
          }
        },
      },
    ],
    logs: [
      [] as LogType[],
      {
        loadLogs: async () => {
          try {
            const response = await fetch(`/api/frames/${props.id}/logs`)
            if (!response.ok) {
              throw new Error('Failed to fetch logs')
            }
            const data = await response.json()
            return data.logs as LogType[]
          } catch (error) {
            console.error(error)
            return []
          }
        },
      },
    ],
  })),
  selectors({
    id: [() => [(_, props) => props.id], (id) => id],
  }),
  afterMount(({ actions }) => {
    actions.loadFrame()
    actions.loadLogs()
  }),
])
