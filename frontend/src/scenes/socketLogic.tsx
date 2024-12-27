import { actions, afterMount, beforeUnmount, kea, path } from 'kea'
import { FrameType, LogType } from '../types'

import type { socketLogicType } from './socketLogicType'
import { inHassioIngress } from '../utils/inHassioIngress'
import { getBasePath } from '../utils/getBasePath'

export const socketLogic = kea<socketLogicType>([
  path(['src', 'scenes', 'socketLogic']),
  actions({
    newLog: (log: LogType) => ({ log }),
    newFrame: (frame: FrameType) => ({ frame }),
    updateFrame: (frame: FrameType) => ({ frame }),
    deleteFrame: ({ id }: { id: number }) => ({ id }),
    updateSettings: (settings: Record<string, any>) => ({ settings }),
    newMetrics: (metrics: Record<string, any>) => ({ metrics }),
  }),
  afterMount(({ actions, cache }) => {
    const token = localStorage.getItem('token')
    if (!token && !inHassioIngress()) {
      console.error('🔴 No token found in localStorage, cannot connect to WebSocket.')
      return
    }

    cache.ws = new WebSocket(`${getBasePath()}/ws` + (token ? `?token=${token}` : ''))
    cache.ws.onopen = function (event: any) {
      console.log('🔵 Connected to the WebSocket server.')
    }

    cache.ws.onmessage = function (event: any) {
      try {
        const data = JSON.parse(event.data)
        switch (data.event) {
          case 'new_log':
            actions.newLog(data.data)
            break
          case 'new_frame':
            actions.newFrame(data.data)
            break
          case 'update_frame':
            actions.updateFrame(data.data)
            break
          case 'delete_frame':
            actions.deleteFrame(data.data)
            break
          case 'update_settings':
            actions.updateSettings(data.data)
            break
          case 'new_metrics':
            actions.newMetrics(data.data)
            break
          default:
            console.log('🟡 Unhandled websocket event:', data)
        }
      } catch (err) {
        console.error('🔴 Failed to parse message as JSON:', event.data)
      }
    }

    cache.ws.onerror = function (error: any) {
      console.error('🔴 WebSocket error:', error)
    }

    cache.ws.onclose = function (event: any) {
      console.log('🔴 WebSocket connection closed:', event)
    }
  }),
  beforeUnmount(({ cache }) => {}),
])
