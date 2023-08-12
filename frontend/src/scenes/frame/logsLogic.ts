import { actions, afterMount, beforeUnmount, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'

import { LogType } from '../../types'
import { loaders } from 'kea-loaders'
import { socketLogic } from '../socketLogic'

import type { logsLogicType } from './logsLogicType'

export interface logsLogicProps {
  id: number
}

export const logsLogic = kea<logsLogicType>([
  path(['src', 'scenes', 'frame', 'logsLogic']),
  props({} as logsLogicProps),
  connect({ logic: [socketLogic] }),
  key((props) => props.id),
  loaders(({ props }) => ({
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
  reducers(({ props }) => ({
    logs: {
      [socketLogic.actionTypes.newLog]: (state, { log }) => (log.frame_id === props.id ? [...state, log] : state),
    },
  })),
  afterMount(({ actions, cache }) => {
    actions.loadLogs()
  }),
])
