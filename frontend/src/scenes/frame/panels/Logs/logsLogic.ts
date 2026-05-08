import { actions, afterMount, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'

import { LogType } from '../../../../types'
import { loaders } from 'kea-loaders'
import { socketLogic } from '../../../socketLogic'

import type { logsLogicType } from './logsLogicType'
import { apiFetch } from '../../../../utils/apiFetch'

export interface LogsLogicProps {
  frameId: number
}
const MAX_LOG_LINES = 50000

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
  }),
  loaders(({ props }) => ({
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
      [socketLogic.actionTypes.newLog]: (state, { log }) =>
        log.frame_id === props.frameId ? [...state, log].slice(-MAX_LOG_LINES) : state,
    },
    fullLogDownloading: [
      false,
      {
        setFullLogDownloading: (_, { downloading }) => downloading,
      },
    ],
  })),
  selectors({
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
    downloadLog: () => {
      downloadTextFile(
        values.logs.map(formatLogLine).join('\n'),
        timestampedLogFileName(props.frameId, 'logs')
      )
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
