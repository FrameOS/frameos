import { afterMount, connect, kea, key, path, props, reducers, selectors } from 'kea'

import { MetricsType } from '../../../../types'
import { loaders } from 'kea-loaders'
import { socketLogic } from '../../../socketLogic'

import type { metricsLogicType } from './metricsLogicType'

export interface metricsLogicProps {
  frameId: number
}

export const metricsLogic = kea<metricsLogicType>([
  path(['src', 'scenes', 'frame', 'metricsLogic']),
  props({} as metricsLogicProps),
  connect({ logic: [socketLogic] }),
  key((props) => props.frameId),
  loaders(({ props }) => ({
    metrics: [
      [] as MetricsType[],
      {
        loadMetrics: async () => {
          try {
            const response = await fetch(`/api/frames/${props.frameId}/metrics`)
            if (!response.ok) {
              throw new Error('Failed to fetch logs')
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
  selectors({
    metricsByCategory: [
      (s) => [s.metrics],
      (metrics) => {
        const metricsByCategory: Record<string, { x: Date; y: number }[]> = {}
        metrics.forEach((metric) => {
          for (const [key, value] of Object.entries(metric.metrics)) {
            if (Array.isArray(value)) {
              for (let i = 0; i < value.length; i++) {
                const subKey = `${key}[${i}]`
                if (!metricsByCategory[subKey]) {
                  metricsByCategory[subKey] = []
                }
                if (typeof value[i] === 'number') {
                  metricsByCategory[subKey].push({ x: new Date(Date.parse(metric.timestamp)), y: value[i] })
                }
              }
            } else if (typeof value === 'object') {
              for (const [subKey, subValue] of Object.entries(value)) {
                if (typeof subValue === 'number') {
                  const fullSubKey = `${key}.${subKey}`
                  if (!metricsByCategory[fullSubKey]) {
                    metricsByCategory[fullSubKey] = []
                  }
                  metricsByCategory[fullSubKey].push({ x: new Date(Date.parse(metric.timestamp)), y: subValue })
                }
              }
            } else if (typeof value === 'number') {
              if (!metricsByCategory[key]) {
                metricsByCategory[key] = []
              }
              metricsByCategory[key].push({ x: new Date(Date.parse(metric.timestamp)), y: value })
            }
          }
        })
        console.log(metricsByCategory)
        return metricsByCategory
      },
    ],
  }),
  afterMount(({ actions, cache }) => {
    actions.loadMetrics()
  }),
])
