import { afterMount, beforeUnmount, kea, path, reducers, selectors } from 'kea'
import { loaders } from 'kea-loaders'

import { apiFetch } from '../../utils/apiFetch'

import type { systemInfoLogicType } from './systemInfoLogicType'

export interface DiskInfo {
  totalBytes: number
  usedBytes: number
  freeBytes: number
}

export interface MemoryInfo {
  totalBytes: number | null
  availableBytes: number | null
}

export interface LoadInfo {
  one: number | null
  five: number | null
  fifteen: number | null
}

export interface CacheInfo {
  name: string
  path: string
  sizeBytes: number
  exists: boolean
}

export interface DatabaseInfo {
  path: string | null
  sizeBytes: number | null
  exists: boolean
}

export interface SystemInfoResponse {
  disk: DiskInfo
  caches: CacheInfo[]
  database: DatabaseInfo
  memory: MemoryInfo
  load: LoadInfo
}

export interface SystemMetricsResponse {
  disk: DiskInfo
  memory: MemoryInfo
  load: LoadInfo
}

export const systemInfoLogic = kea<systemInfoLogicType>([
  path(['src', 'scenes', 'settings', 'systemInfoLogic']),
  loaders(() => ({
    systemInfo: [
      null as SystemInfoResponse | null,
      {
        loadSystemInfo: async () => {
          const response = await apiFetch(`/api/system/info`)
          if (!response.ok) {
            throw new Error('Failed to fetch system information')
          }
          return (await response.json()) as SystemInfoResponse
        },
      },
    ],
    systemMetrics: [
      null as SystemMetricsResponse | null,
      {
        loadSystemMetrics: async () => {
          const response = await apiFetch(`/api/system/metrics`)
          if (!response.ok) {
            throw new Error('Failed to fetch system metrics')
          }
          return (await response.json()) as SystemMetricsResponse
        },
      },
    ],
  })),
  reducers({
    systemInfo: {
      loadSystemInfoFailure: () => null,
    },
    systemMetrics: {
      loadSystemMetricsFailure: () => null,
    },
  }),
  selectors({
    currentDisk: [
      (s) => [s.systemMetrics, s.systemInfo],
      (systemMetrics, systemInfo) => systemMetrics?.disk ?? systemInfo?.disk ?? null,
    ],
    currentMemory: [
      (s) => [s.systemMetrics, s.systemInfo],
      (systemMetrics, systemInfo) => systemMetrics?.memory ?? systemInfo?.memory ?? null,
    ],
    currentLoad: [
      (s) => [s.systemMetrics, s.systemInfo],
      (systemMetrics, systemInfo) => systemMetrics?.load ?? systemInfo?.load ?? null,
    ],
  }),
  afterMount(({ actions, cache }) => {
    actions.loadSystemInfo()
    const refreshMetrics = () => actions.loadSystemMetrics()
    refreshMetrics()
    cache.metricsInterval = window.setInterval(refreshMetrics, 5000)
  }),
  beforeUnmount(({ cache }) => {
    if (cache.metricsInterval) {
      window.clearInterval(cache.metricsInterval)
    }
  }),
])
