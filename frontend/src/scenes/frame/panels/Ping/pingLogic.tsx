import { actions, afterMount, beforeUnmount, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'
import { frameLogic } from '../../frameLogic'
import { apiFetch } from '../../../../utils/apiFetch'

export type PingMode = 'icmp' | 'http'

export type PingResult = {
  id: number
  timestamp: string
  clientElapsedMs: number | null
  serverElapsedMs: number | null
  icmpTimeMs: number | null
  ok: boolean
  message: string
  mode: PingMode
  target: string
  status?: number | null
}

export interface PingLogicProps {
  frameId: number
}

const MAX_RESULTS = 200
const ICMP_TIME_REGEX = /time[=<]\s*([\d.]+)\s*ms/i

const normalizeIntervalSeconds = (value: number | null | undefined) => {
  if (!Number.isFinite(value)) {
    return 1
  }
  return Math.max(1, value ?? 1)
}

const normalizePingMode = (value: string | null | undefined): PingMode => (value === 'http' ? 'http' : 'icmp')

const normalizePath = (value: string | null | undefined) => {
  const trimmed = (value ?? '').trim() || '/ping'
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

const extractIcmpTime = (message: string) => {
  const match = message.match(ICMP_TIME_REGEX)
  if (!match) {
    return null
  }
  const parsed = Number(match[1])
  return Number.isFinite(parsed) ? parsed : null
}

export const pingLogic = kea([
  path(['src', 'scenes', 'frame', 'panels', 'Ping', 'pingLogic']),
  props({} as PingLogicProps),
  key((props: PingLogicProps) => props.frameId),
  connect(({ frameId }: PingLogicProps) => ({
    values: [frameLogic({ frameId }), ['frame']],
  })),
  actions({
    setIntervalSeconds: (intervalSeconds: number | null) => ({ intervalSeconds }),
    setPingMode: (pingMode: PingMode | string) => ({ pingMode }),
    setHttpPath: (httpPath: string) => ({ httpPath }),
    toggleRunning: true,
    startRunning: true,
    stopRunning: true,
    runPing: true,
    setIsPinging: (isPinging: boolean) => ({ isPinging }),
    appendResult: (result: PingResult) => ({ result }),
    scheduleNext: (elapsed: number) => ({ elapsed }),
  }),
  reducers({
    intervalSeconds: [
      1,
      {
        setIntervalSeconds: (_, { intervalSeconds }) => normalizeIntervalSeconds(intervalSeconds),
      },
    ],
    pingMode: [
      'icmp' as PingMode,
      {
        setPingMode: (_, { pingMode }) => normalizePingMode(pingMode),
      },
    ],
    httpPath: [
      '/ping',
      {
        setHttpPath: (_, { httpPath }) => httpPath,
      },
    ],
    isRunning: [
      false,
      {
        startRunning: () => true,
        stopRunning: () => false,
      },
    ],
    isPinging: [
      false,
      {
        setIsPinging: (_, { isPinging }) => isPinging,
        stopRunning: () => false,
      },
    ],
    results: [
      [] as PingResult[],
      {
        appendResult: (state, { result }) => [result, ...state].slice(0, MAX_RESULTS),
      },
    ],
  }),
  selectors({
    intervalMs: [(s) => [s.intervalSeconds], (intervalSeconds) => normalizeIntervalSeconds(intervalSeconds) * 1000],
    normalisedPath: [(s) => [s.httpPath], (httpPath) => normalizePath(httpPath)],
    targetLabel: [
      (s) => [s.frame, s.normalisedPath, s.pingMode],
      (frame, normalisedPath, pingMode) => {
        const host = frame?.frame_host || 'frame'
        const port = frame?.frame_port ? `:${frame.frame_port}` : ''
        return pingMode === 'http' ? `${host}${port}${normalisedPath}` : host
      },
    ],
  }),
  listeners(({ actions, values, cache, props }) => ({
    toggleRunning: () => {
      if (values.isRunning) {
        actions.stopRunning()
      } else {
        actions.startRunning()
      }
    },
    startRunning: () => {
      if (cache.timeoutId) {
        window.clearTimeout(cache.timeoutId)
        cache.timeoutId = null
      }
      actions.runPing()
    },
    stopRunning: () => {
      if (cache.timeoutId) {
        window.clearTimeout(cache.timeoutId)
        cache.timeoutId = null
      }
    },
    setIntervalSeconds: () => {
      if (values.isRunning) {
        actions.stopRunning()
        actions.startRunning()
      }
    },
    setPingMode: () => {
      if (values.isRunning) {
        actions.stopRunning()
        actions.startRunning()
      }
    },
    setHttpPath: () => {
      if (values.isRunning) {
        actions.stopRunning()
        actions.startRunning()
      }
    },
    scheduleNext: ({ elapsed }) => {
      if (!values.isRunning) {
        return
      }
      if (cache.timeoutId) {
        window.clearTimeout(cache.timeoutId)
        cache.timeoutId = null
      }
      const delay = Math.max(values.intervalMs - elapsed, 0)
      cache.timeoutId = window.setTimeout(() => {
        actions.runPing()
      }, delay)
    },
    runPing: async () => {
      const startedAt = Date.now()
      actions.setIsPinging(true)
      cache.requestId = (cache.requestId ?? 0) + 1
      const id = cache.requestId as number
      let ok = false
      let message = ''
      let mode: PingMode = values.pingMode
      let target = values.targetLabel
      let status: number | null | undefined = null
      let payload: {
        elapsed_ms?: number | null
        ok?: boolean
        mode?: PingMode
        target?: string
        status?: number | null
        message?: string
      } | null = null
      let responseText: string | null = null

      try {
        const params = new URLSearchParams({ mode: values.pingMode })
        if (values.pingMode === 'http') {
          params.set('path', values.normalisedPath)
        }
        const response = await apiFetch(`/api/frames/${props.frameId}/ping?${params.toString()}`)
        const contentType = response.headers.get('content-type') ?? ''
        if (contentType.includes('application/json')) {
          try {
            payload = await response.json()
          } catch (error) {
            message = error instanceof Error ? error.message : String(error)
          }
        } else {
          responseText = (await response.text()).trim()
        }

        ok = payload?.ok ?? response.ok
        mode = (payload?.mode as PingMode) || values.pingMode
        target = payload?.target ?? values.targetLabel
        status = mode === 'http' ? (payload ? payload.status ?? null : response.status) : null
        if (payload?.message) {
          message = payload.message
        } else if (payload && Object.keys(payload).length > 0) {
          message = JSON.stringify(payload)
        } else {
          message = responseText || (ok ? 'pong' : `HTTP ${response.status}`)
        }
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }

      const elapsed = Date.now() - startedAt
      const clientElapsedMs = elapsed
      const serverElapsedMs = payload?.elapsed_ms ?? null
      const icmpTimeMs = mode === 'icmp' ? extractIcmpTime(message) : null
      actions.appendResult({
        id,
        timestamp: new Date().toLocaleTimeString(),
        clientElapsedMs,
        serverElapsedMs,
        icmpTimeMs,
        ok,
        message,
        mode,
        target,
        status,
      })
      actions.setIsPinging(false)
      actions.scheduleNext(elapsed)
    },
  })),
  afterMount(({ cache }) => {
    cache.timeoutId = null
    cache.requestId = 0
  }),
  beforeUnmount(({ cache }) => {
    if (cache.timeoutId) {
      window.clearTimeout(cache.timeoutId)
      cache.timeoutId = null
    }
  }),
])

export const formatMs = (value: number, precision = 0) => {
  const fixed = value.toFixed(precision)
  return fixed.replace(/\.?0+$/, '')
}
