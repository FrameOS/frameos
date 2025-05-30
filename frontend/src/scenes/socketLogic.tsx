import { actions, afterMount, kea, path } from 'kea'
import { FrameType, LogType } from '../types'

import type { socketLogicType } from './socketLogicType'
import { inHassioIngress } from '../utils/inHassioIngress'
import { getBasePath } from '../utils/getBasePath'

export const socketLogic = kea<socketLogicType>([
  path(['src', 'scenes', 'socketLogic']),
  actions({
    newLog: (log: LogType) => ({ log }),
    newFrame: (frame: FrameType) => ({ frame }),
    newSceneImage: (frameId: number, sceneId: string, width: number, height: number) => ({
      frameId,
      sceneId,
      width,
      height,
    }),
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

    function openConnection() {
      cache.ws = new WebSocket(`${getBasePath()}/ws` + (token ? `?token=${token}` : ''))
      cache.ws.onopen = function (event: any) {
        console.log('🔵 Connected to the WebSocket server.')
      }

      cache.ws.onmessage = function (event: any) {
        try {
          const data = JSON.parse(event.data)
          console.info('🟢 WebSocket message received:', data)
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
            case 'new_scene_image':
              actions.newSceneImage(data.data.frameId, data.data.sceneId, data.data.width, data.data.height)
              break
            case 'update_settings':
              actions.updateSettings(data.data)
              break
            case 'new_metrics':
              actions.newMetrics(data.data)
              break
            case 'pong':
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
        console.log('🔴 WebSocket connection closed. Reconnecting...', event)
        if (event.code === 1000) {
          // For some reason Home Assistant Ingress closes the connection after 40 seconds. If that happens, reopen.
          window.setTimeout(openConnection, 0)
        } else {
          window.setTimeout(openConnection, 1000)
        }
      }
    }

    openConnection()
  }),
])
