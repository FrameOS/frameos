import { actions, afterMount, beforeUnmount, kea, key, listeners, path, props, reducers, selectors } from 'kea'

import type { frameLogicType } from './frameLogicType'
import { FrameType, LogType } from '~/types'
import { loaders } from 'kea-loaders'
import { connect } from 'socket.io-client'

export interface FrameLogicProps {
  id: number
}

export const frameLogic = kea<frameLogicType>([
  path(['src', 'scenes', 'frame', 'frameLogic']),
  props({} as FrameLogicProps),
  key((props) => props.id),

  actions({ initialize: true, addLog: (log: LogType) => ({ log }) }),
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
  reducers({
    logs: {
      addLog: (state, { log }) => [...state, log],
    },
  }),
  selectors({
    id: [() => [(_, props) => props.id], (id) => id],
  }),
  listeners(({ props }) => ({
    initialize: async () => {
      await fetch(`/api/frames/${props.id}/initialize`, { method: 'POST' })
    },
  })),
  afterMount(({ actions, cache }) => {
    actions.loadFrame()
    actions.loadLogs()
    cache.socket = connect('/')
    cache.socket.on('new_line', actions.addLog)
  }),
  beforeUnmount(({ cache }) => {
    cache.socket.close()
  }),
])
