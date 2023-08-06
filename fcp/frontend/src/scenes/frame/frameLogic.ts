import { actions, afterMount, beforeUnmount, kea, key, listeners, path, props, reducers, selectors } from 'kea'

import type { frameLogicType } from './frameLogicType'
import { FrameType, LogType } from '~/types'
import { loaders } from 'kea-loaders'
import { connect } from 'socket.io-client'
import { socketLogic } from '../socketLogic'

export interface FrameLogicProps {
  id: number
}

export const frameLogic = kea<frameLogicType>([
  path(['src', 'scenes', 'frame', 'frameLogic']),
  props({} as FrameLogicProps),
  key((props) => props.id),

  actions({ initialize: true }),
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
  reducers(({ props }) => ({
    logs: {
      [socketLogic.actionTypes.newLog]: (state, { log }) => (log.frame_id === props.id ? [...state, log] : state),
    },
    frame: {
      [socketLogic.actionTypes.newFrame]: (state, { frame }) => (frame.id === props.id ? frame : state),
      [socketLogic.actionTypes.updateFrame]: (state, { frame }) => (frame.id === props.id ? frame : state),
    },
  })),
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
  }),
])
