import { useValues } from 'kea'
import { metricsLogic } from './metricsLogic'
import { frameLogic } from '../../frameLogic'
import React from 'react'
import { ParentSize } from '@visx/responsive'
import { BrushChart } from './BrushChart'

export function Metrics() {
  const { frameId } = useValues(frameLogic)
  const { metrics, metricsByCategory, metricsLoading } = useValues(metricsLogic({ frameId }))

  return metricsLoading ? (
    <div>...</div>
  ) : metrics.length === 0 ? (
    <div>No Metrics yet</div>
  ) : (
    <div className="h-full p-2 relative">
      <ParentSize>
        {(parent) =>
          Object.entries(metricsByCategory).map(([key, data]) => (
            <div>
              <strong>{key}</strong>
              <div className="h-[200px] text-white">
                <BrushChart width={parent.width} height={200} data={data} />
              </div>
            </div>
          ))
        }
      </ParentSize>
    </div>
  )
}
