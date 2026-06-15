import { actions, afterMount, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'

import { LogType } from '../../../../types'
import { loaders } from 'kea-loaders'
import { socketLogic } from '../../../socketLogic'

import type { logsLogicType } from './logsLogicType'
import { apiFetch } from '../../../../utils/apiFetch'
import { embeddedUsbLogsModel } from '../../../../models/embeddedUsbLogsModel'

export interface LogsLogicProps {
  frameId: number
}
const MAX_LOG_LINES = 50000

// Duplicate lines appear when a REST load (initial mount — e.g. the deploy
// drawer mounting this logic mid-deploy — or the reconnect catch-up) races
// the live websocket stream: a line already in the fetched response is
// appended again when its socket event arrives moments later. Ids are
// monotonically increasing, so scanning a short tail is enough to dedup.
const DEDUP_TAIL_LINES = 500
function hasLogId(logs: LogType[], id: number): boolean {
  const end = Math.max(0, logs.length - DEDUP_TAIL_LINES)
  for (let index = logs.length - 1; index >= end; index--) {
    if (logs[index].id === id) {
      return true
    }
  }
  return false
}

function mergeLogsById(logs: LogType[], extraLogs: LogType[]): LogType[] {
  const ids = new Set(logs.map((log) => log.id))
  const merged = [...logs]
  for (const log of extraLogs) {
    if (!ids.has(log.id)) {
      ids.add(log.id)
      merged.push(log)
    }
  }
  return merged.slice(-MAX_LOG_LINES)
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

function downloadTextFile(content: string, fileName: string): void {
  downloadBlob(new Blob([content], { type: 'text/plain;charset=utf-8' }), fileName)
}

function timestampedLogFileName(frameId: number, type: 'logs' | 'full-logs'): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `frame-${frameId}-${type}-${timestamp}.log`
}

function formatLogLine(log: LogType): string {
  const isoTimestamp = new Date(log.timestamp).toISOString()
  return `[${isoTimestamp}] (${log.type}) ${log.line}`
}

function logMatchesSearch(log: LogType, search: string): boolean {
  const normalizedSearch = search.trim().toLowerCase()
  if (!normalizedSearch) {
    return true
  }
  return [log.timestamp, log.type, log.ip, log.line].some((value) =>
    String(value ?? '')
      .toLowerCase()
      .includes(normalizedSearch)
  )
}

function fileNameFromContentDisposition(header: string | null): string | null {
  if (!header) {
    return null
  }
  const utf8Match = header.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf8Match?.[1]) {
    return decodeURIComponent(utf8Match[1])
  }
  const asciiMatch = header.match(/filename="?([^";]+)"?/i)
  return asciiMatch?.[1] ?? null
}

export const logsLogic = kea<logsLogicType>([
  path(['src', 'scenes', 'frame', 'logsLogic']),
  props({} as LogsLogicProps),
  connect(() => ({ logic: [socketLogic] })),
  key((props) => props.frameId),
  actions({
    downloadLog: true,
    downloadFullLog: true,
    setFullLogDownloading: (downloading: boolean) => ({ downloading }),
    setLogSearch: (search: string) => ({ search }),
    appendLog: (log: LogType) => ({ log }),
  }),
  loaders(({ props, values }) => ({
    logs: [
      [] as LogType[],
      {
        loadLogs: async () => {
          try {
            const response = await apiFetch(`/api/frames/${props.frameId}/logs`)
            if (!response.ok) {
              throw new Error('Failed to fetch logs')
            }
            const data = await response.json()
            const fetched = data.logs as LogType[]
            // Live lines may have streamed in over the websocket while the
            // fetch was in flight; keep them instead of clobbering, dedup by id.
            const fetchedIds = new Set(fetched.map((log) => log.id))
            const usbLogs = embeddedUsbLogsModel.values.usbLogsByFrameId[props.frameId] ?? []
            const streamedDuringFetch = mergeLogsById(values.logs, usbLogs).filter((log) => !fetchedIds.has(log.id))
            return [...fetched, ...streamedDuringFetch].slice(-MAX_LOG_LINES)
          } catch (error) {
            console.error(error)
            return values.logs
          }
        },
        // Fetch only the lines newer than what we already have (used on
        // websocket reconnect) and append them, instead of re-downloading the
        // whole buffer every time a flaky connection drops. Falls back to a
        // full load if we have nothing yet.
        loadNewLogs: async () => {
          const maxId = values.logs.reduce((max, log) => (log.id > max ? log.id : max), 0)
          if (!maxId) {
            return values.logs
          }
          try {
            const response = await apiFetch(`/api/frames/${props.frameId}/logs?after_id=${maxId}`)
            if (!response.ok) {
              throw new Error('Failed to fetch logs')
            }
            const data = await response.json()
            // Re-read state after the await: live lines may have been appended
            // while the fetch was in flight, and may overlap with the response.
            const current = values.logs
            const knownIds = new Set(current.map((log) => log.id))
            const newLogs = (data.logs as LogType[]).filter((log) => log.id > maxId && !knownIds.has(log.id))
            if (newLogs.length === 0) {
              return current
            }
            return [...current, ...newLogs].slice(-MAX_LOG_LINES)
          } catch (error) {
            console.error(error)
            return values.logs
          }
        },
      },
    ],
  })),
  reducers(() => ({
    logs: {
      // Live lines stream in via the appendLog listener below (a local action)
      // rather than keying this reducer on socketLogic's external newLog action,
      // which would conflict with the socketReconnected listener under
      // kea-typegen and break this reducer's typing.
      appendLog: (state, { log }) => (hasLogId(state, log.id) ? state : [...state, log].slice(-MAX_LOG_LINES)),
    },
    fullLogDownloading: [
      false,
      {
        setFullLogDownloading: (_, { downloading }) => downloading,
      },
    ],
    logSearch: [
      '',
      {
        setLogSearch: (_, { search }) => search,
      },
    ],
  })),
  selectors({
    filteredLogs: [
      (selectors) => [selectors.logs, selectors.logSearch],
      (logs, logSearch) => {
        const normalizedSearch = logSearch.trim()
        if (!normalizedSearch) {
          return logs
        }
        return logs.filter((log) => logMatchesSearch(log, normalizedSearch))
      },
    ],
    ipAddresses: [
      (selectors) => [selectors.logs],
      (logs) => {
        const ips = new Set<string>()
        logs.forEach((log) => {
          if (log.ip) {
            ips.add(log.ip)
          }
        })
        return Array.from(ips).sort()
      },
      { resultEqualityCheck: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
    ],
  }),
  listeners(({ actions, props, values }) => ({
    [socketLogic.actionTypes.newLog]: ({ log }) => {
      if (log.frame_id === props.frameId) {
        actions.appendLog(log)
      }
    },
    [embeddedUsbLogsModel.actionTypes.appendUsbLog]: ({ log }) => {
      if (log.frame_id === props.frameId) {
        actions.appendLog(log)
      }
    },
    [socketLogic.actionTypes.socketReconnected]: () => {
      // Lines missed during the outage are fetched incrementally (only rows
      // newer than our latest id), not by re-downloading the whole buffer.
      actions.loadNewLogs()
    },
    downloadLog: () => {
      downloadTextFile(values.logs.map(formatLogLine).join('\n'), timestampedLogFileName(props.frameId, 'logs'))
    },
    downloadFullLog: async () => {
      actions.setFullLogDownloading(true)
      try {
        const response = await apiFetch(`/api/frames/${props.frameId}/logs/full`)
        if (!response.ok) {
          throw new Error('Failed to download full logs')
        }
        const fileName =
          fileNameFromContentDisposition(response.headers.get('content-disposition')) ??
          timestampedLogFileName(props.frameId, 'full-logs')
        downloadBlob(await response.blob(), fileName)
      } catch (error) {
        console.error(error)
      } finally {
        actions.setFullLogDownloading(false)
      }
    },
  })),
  afterMount(({ actions }) => {
    actions.loadLogs()
  }),
])
