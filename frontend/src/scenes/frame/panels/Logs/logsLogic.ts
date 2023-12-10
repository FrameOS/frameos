import { afterMount, connect, kea, key, path, props, reducers } from 'kea'

import { LogType } from '../../../../types'
import { loaders } from 'kea-loaders'
import { socketLogic } from '../../../socketLogic'

import type { logsLogicType } from './logsLogicType'

export interface logsLogicProps {
  frameId: number
}
const MAX_LOG_LINES = 100000

export const logsLogic = kea<logsLogicType>([
  path(['src', 'scenes', 'frame', 'logsLogic']),
  props({} as logsLogicProps),
  connect({ logic: [socketLogic] }),
  key((props) => props.frameId),
  loaders(({ props }) => ({
    logs: [
      [] as LogType[],
      {
        loadLogs: async () => {
          try {
            const response = await fetch(`/api/frames/${props.frameId}/logs`)
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
  reducers(({ props }) => ({
    logs: {
      [socketLogic.actionTypes.newLog]: (state, { log }) =>
        log.frame_id === props.frameId ? [...state, log].slice(-MAX_LOG_LINES) : state,
    },
  })),
  afterMount(({ actions, cache }) => {
    actions.loadLogs()
  }),
])
