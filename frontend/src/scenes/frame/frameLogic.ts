import { actions, afterMount, beforeUnmount, kea, key, listeners, path, props, reducers, selectors } from 'kea'

import type { frameLogicType } from './frameLogicType'
import { FrameType, LogType } from '../../types'
import { loaders } from 'kea-loaders'
import { socketLogic } from '../socketLogic'
import { forms } from 'kea-forms'

export interface FrameLogicProps {
  id: number
}

export const frameLogic = kea<frameLogicType>([
  path(['src', 'scenes', 'frame', 'frameLogic']),
  props({} as FrameLogicProps),
  key((props) => props.id),

  actions({ initialize: true, refresh: true, updateImage: true }),
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
    frame: [
      null as FrameType | null,
      {
        [socketLogic.actionTypes.newFrame]: (state, { frame }) => (frame.id === props.id ? frame : state),
        [socketLogic.actionTypes.updateFrame]: (state, { frame }) => (frame.id === props.id ? frame : state),
      },
    ],
    frameImageCounter: [
      0,
      {
        updateImage: (state) => state + 1,
      },
    ],
  })),
  selectors(() => ({
    id: [() => [(_, props) => props.id], (id) => id],
    frameImage: [
      (s) => [(_, props) => props.id, s.frameImageCounter],
      (id, counter) => {
        return `/api/frames/${id}/image?t=${new Date().valueOf() + counter}`
      },
    ],
  })),
  listeners(({ props, actions }) => ({
    initialize: async () => {
      await fetch(`/api/frames/${props.id}/initialize`, { method: 'POST' })
    },
    refresh: async () => {
      await fetch(`/api/frames/${props.id}/refresh`, { method: 'POST' })
    },
    [socketLogic.actionTypes.newLog]: ({ log }) => {
      if (log.type === 'webhook') {
        const parsed = JSON.parse(log.line)
        if (parsed.event == 'refresh_begin' || parsed.event == 'refresh_end') {
          actions.updateImage()
        }
      }
    },
  })),
  forms(({ actions, values }) => ({
    frame: {
      defaults: null as FrameType | null,
      submit: async () => {
        actions.initialize()
      },
    },
  })),
  afterMount(({ actions, cache }) => {
    actions.loadFrame()
    actions.loadLogs()
  }),
])
