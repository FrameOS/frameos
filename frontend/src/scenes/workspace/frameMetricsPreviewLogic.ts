import { actions, afterMount, beforeUnmount, connect, kea, key, path, props, reducers, selectors } from 'kea'
import { loaders } from 'kea-loaders'

import type { MetricsType } from '../../types'
import { apiFetch } from '../../utils/apiFetch'
import {
  filterMetricsByCategoryAndTimeRange,
  latestMetricSummariesByCategoryFromMetrics,
  metricsByCategoryFromMetrics,
  metricTimestamp,
  type MetricSeries,
  type TimeRange,
} from '../frame/panels/Metrics/metricsLogic'
import { socketLogic } from '../socketLogic'

import type { frameMetricsPreviewLogicType } from './frameMetricsPreviewLogicType'

const PREVIEW_METRICS_WINDOW_MS = 60 * 60 * 1000
const PREVIEW_METRICS_LIMIT = 1000
const CURRENT_TIME_UPDATE_MS = 60 * 1000

export interface FrameMetricsPreviewLogicProps {
  frameId: number
}

export const frameMetricsPreviewLogic = kea<frameMetricsPreviewLogicType>([
  path(['src', 'scenes', 'workspace', 'frameMetricsPreviewLogic']),
  props({} as FrameMetricsPreviewLogicProps),
  connect(() => ({ logic: [socketLogic] })),
  key((props) => props.frameId),
  actions({
    setCurrentTime: (currentTime: number) => ({ currentTime }),
  }),
  loaders(({ props }) => ({
    recentMetrics: [
      [] as MetricsType[],
      {
        loadRecentMetrics: async () => {
          try {
            const since = new Date(Date.now() - PREVIEW_METRICS_WINDOW_MS).toISOString()
            const response = await apiFetch(
              `/api/frames/${props.frameId}/metrics/recent?limit=${PREVIEW_METRICS_LIMIT}&since=${encodeURIComponent(
                since
              )}`
            )
            if (!response.ok) {
              throw new Error('Failed to fetch recent metrics')
            }
            const data = await response.json()
            return data.metrics as MetricsType[]
          } catch (error) {
            console.error(error)
            return []
          }
        },
      },
    ],
  })),
  reducers(({ props }) => ({
    currentTime: [
      Date.now(),
      {
        setCurrentTime: (_, { currentTime }) => currentTime,
      },
    ],
    recentMetrics: {
      [socketLogic.actionTypes.newMetrics]: (state, { metrics }) => {
        if (metrics.frame_id !== props.frameId) {
          return state
        }
        const cutoff = Date.now() - PREVIEW_METRICS_WINDOW_MS
        return [...state, metrics as MetricsType].filter((metric) => metricTimestamp(metric) >= cutoff)
      },
    },
  })),
  selectors({
    sortedRecentMetrics: [
      (s) => [s.recentMetrics],
      (metrics) => [...metrics].sort((a, b) => metricTimestamp(a) - metricTimestamp(b)),
    ],
    previewMetricsTimeRange: [
      (s) => [s.currentTime, s.sortedRecentMetrics],
      (currentTime, metrics): TimeRange | null =>
        metrics.length === 0 ? null : { start: currentTime - PREVIEW_METRICS_WINDOW_MS, end: currentTime },
    ],
    metricsByCategory: [
      (s) => [s.sortedRecentMetrics],
      (metrics): Record<string, MetricSeries[]> => metricsByCategoryFromMetrics(metrics),
    ],
    headerMetricsByCategory: [
      (s) => [s.metricsByCategory, s.previewMetricsTimeRange],
      (metricsByCategory, previewMetricsTimeRange) =>
        filterMetricsByCategoryAndTimeRange(
          metricsByCategory,
          ['load', 'memoryUsage', 'diskUsage'],
          previewMetricsTimeRange
        ),
    ],
    latestMetricSummariesByCategory: [
      (s) => [s.sortedRecentMetrics],
      (metrics): Record<string, string> => latestMetricSummariesByCategoryFromMetrics(metrics),
    ],
  }),
  afterMount(({ actions, cache }) => {
    actions.loadRecentMetrics()
    actions.setCurrentTime(Date.now())
    cache.currentTimeInterval = window.setInterval(() => actions.setCurrentTime(Date.now()), CURRENT_TIME_UPDATE_MS)
  }),
  beforeUnmount(({ cache }) => {
    if (cache.currentTimeInterval) {
      window.clearInterval(cache.currentTimeInterval)
    }
  }),
])
