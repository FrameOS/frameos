import { afterMount, connect, kea, key, path, props, reducers, selectors } from 'kea'

import { LogType } from '../../../../types'
import { loaders } from 'kea-loaders'
import { socketLogic } from '../../../socketLogic'

import type { logsLogicType } from './logsLogicType'
import { apiFetch } from '../../../../utils/apiFetch'

export interface LogsLogicProps {
  frameId: number
}
const MAX_LOG_LINES = 50000

export const logsLogic = kea<logsLogicType>([
  path(['src', 'scenes', 'frame', 'logsLogic']),
  props({} as LogsLogicProps),
  connect(() => ({ logic: [socketLogic] })),
  key((props) => props.frameId),
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
  afterMount(({ actions }) => {
    actions.loadLogs()
  }),
])
