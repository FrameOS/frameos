import { actions, afterMount, beforeUnmount, kea, path } from 'kea'
import { AiSceneLogType, FrameType, LogType } from '../types'

import type { socketLogicType } from './socketLogicType'
import { getBasePath } from '../utils/getBasePath'
import { getFrameControlFrameId, isFrameControlMode } from '../utils/frameControlMode'
import { isInFrameAdminMode } from '../utils/frameAdmin'

export const socketLogic = kea<socketLogicType>([
  path(['src', 'scenes', 'socketLogic']),
  actions({
    newLog: (log: LogType) => ({ log }),
    aiSceneLog: (log: AiSceneLogType) => ({ log }),
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
    frameRendered: (frameId: number) => ({ frameId }),
    // Fired when the socket reopens after a drop. All frame state is
    // event-sourced over this socket, so listeners must refetch anything
    // they may have missed while disconnected.
    socketReconnected: true,
  }),
  afterMount(({ actions, cache }) => {
    if (typeof window !== 'undefined' && (window as any).FRAMEOS_EMBEDDED_NO_BACKEND) {
      return
    }
    const frameControlMode = isFrameControlMode()
    const isFrameOSAdmin = isInFrameAdminMode()

    cache.reconnectAttempts = 0
    cache.everDisconnected = false
    cache.unmounted = false

    function openConnection() {
      const wsPath = isFrameOSAdmin ? '/ws/admin' : '/ws'
      cache.ws = new WebSocket(`${getBasePath()}${wsPath}`)
      cache.ws.onopen = function (event: any) {
        console.log('🔵 Connected to the WebSocket server.')
        cache.openedAt = Date.now()
        if (cache.everDisconnected) {
          actions.socketReconnected()
        }
      }

      cache.ws.onmessage = function (event: any) {
        if ((frameControlMode || isFrameOSAdmin) && event.data === 'render') {
          actions.frameRendered(getFrameControlFrameId())
          return
        }
        try {
          const data = JSON.parse(event.data)
          console.info('🟢 WebSocket message received:', data)
          switch (data.event) {
            case 'new_log':
              actions.newLog(data.data)
              break
            case 'ai_scene_log':
              actions.aiSceneLog(data.data)
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
            case 'frame_rendered':
              actions.frameRendered(data.data.frameId)
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
          if (!frameControlMode) {
            console.error('🔴 Failed to parse message as JSON:', event.data)
          }
        }
      }

      cache.ws.onerror = function (error: any) {
        console.error('🔴 WebSocket error:', error)
      }

      cache.ws.onclose = function (event: any) {
        if (cache.unmounted) {
          return
        }
        cache.everDisconnected = true
        const uptimeMs = cache.openedAt ? Date.now() - cache.openedAt : 0
        cache.openedAt = null
        if (uptimeMs > 5000) {
          // The previous connection was healthy; start the backoff over.
          cache.reconnectAttempts = 0
        }
        const attempt = cache.reconnectAttempts++
        // Home Assistant Ingress closes healthy connections with code 1000
        // after ~40s: reconnect immediately. Anything else backs off
        // exponentially so a down backend isn't hammered once a second.
        const delayMs = event.code === 1000 && attempt === 0 ? 0 : Math.min(1000 * 2 ** attempt, 30000)
        console.log(`🔴 WebSocket connection closed. Reconnecting in ${delayMs}ms...`, event)
        cache.reconnectTimeout = window.setTimeout(openConnection, delayMs)
      }
    }

    openConnection()
  }),
  beforeUnmount(({ cache }) => {
    cache.unmounted = true
    if (cache.reconnectTimeout) {
      window.clearTimeout(cache.reconnectTimeout)
      cache.reconnectTimeout = null
    }
    if (cache.ws) {
      cache.ws.close()
      cache.ws = null
    }
  }),
])
