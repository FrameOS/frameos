import { actions, afterMount, beforeUnmount, kea, listeners, path, reducers } from 'kea'

import {
  appendAccessKey,
  getAccessKeyFromLocation,
  getInitialScalingMode,
  getRequestedScalingMode,
} from '../../utils/frameAuth'

const initialScalingMode = getInitialScalingMode()
const requestedScalingMode = getRequestedScalingMode()
const shouldToggleScaling =
  requestedScalingMode &&
  ((requestedScalingMode.includes('cover') && initialScalingMode.includes('contain')) ||
    (requestedScalingMode.includes('contain') && initialScalingMode.includes('cover')))

export const imageLogic = kea([
  path(['frameos', 'frontend', 'imageLogic']),
  actions({
    refreshImage: true,
    imageLoaded: (url: string, nextIndex: number) => ({ url, nextIndex }),
    setScalingMode: (mode: string) => ({ mode }),
    toggleScalingMode: true,
  }),
  reducers({
    accessKey: [getAccessKeyFromLocation(), {}],
    scalingMode: [
      shouldToggleScaling ? (initialScalingMode.includes('cover') ? 'contain' : 'cover') : initialScalingMode,
      {
        setScalingMode: (_, { mode }) => mode,
        toggleScalingMode: (state) => (state === 'cover' ? 'contain' : 'cover'),
      },
    ],
    imageSlots: [
      [null, null] as [string | null, string | null],
      {
        imageLoaded: (state, { url, nextIndex }) => {
          const next = [...state] as [string | null, string | null]
          next[nextIndex] = url
          return next
        },
      },
    ],
    activeIndex: [
      0,
      {
        imageLoaded: (_, { nextIndex }) => nextIndex,
      },
    ],
  }),
  listeners(({ actions, values, cache }) => ({
    refreshImage: () => {
      const imageUrl = appendAccessKey(`/image?t=${Date.now()}`, values.accessKey)
      const nextIndex = values.activeIndex === 0 ? 1 : 0
      cache.pendingImageUrl = imageUrl
      cache.pendingIndex = nextIndex
      const tempImage = new Image()
      tempImage.onload = () => {
        if (cache.pendingImageUrl === imageUrl && cache.pendingIndex === nextIndex) {
          actions.imageLoaded(imageUrl, nextIndex)
        }
      }
      tempImage.src = imageUrl
    },
  })),
  afterMount(({ actions, values, cache }) => {
    cache.shouldReconnect = true
    const connectWebSocket = () => {
      if (!cache.shouldReconnect) {
        return
      }
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const wsBase = `${wsProtocol}//${window.location.host}/ws`
      const wsUrl = appendAccessKey(wsBase, values.accessKey)
      const ws = new WebSocket(wsUrl)
      cache.ws = ws

      ws.onopen = () => {
        actions.refreshImage()
      }

      ws.onmessage = (event) => {
        if (event.data === 'render') {
          actions.refreshImage()
        }
      }

      ws.onclose = (event) => {
        if (cache.shouldReconnect && event.code !== 1000) {
          cache.reconnectTimeout = window.setTimeout(connectWebSocket, 3000)
        }
      }
    }

    connectWebSocket()
    actions.refreshImage()
  }),
  beforeUnmount(({ cache }) => {
    cache.shouldReconnect = false
    if (cache.reconnectTimeout) {
      window.clearTimeout(cache.reconnectTimeout)
      cache.reconnectTimeout = null
    }
    if (cache.ws) {
      cache.ws.close(1000, 'unmount')
      cache.ws = null
    }
  }),
])
