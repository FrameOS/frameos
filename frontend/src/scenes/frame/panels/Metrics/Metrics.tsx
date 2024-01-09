import { useValues } from 'kea'
import { metricsLogic } from './metricsLogic'
import { frameLogic } from '../../frameLogic'
import { ResponsiveLine } from '@nivo/line'

export function Metrics() {
  const { frameId } = useValues(frameLogic)
  const { metrics, metricsByCategory, metricsLoading } = useValues(metricsLogic({ frameId }))

  return metricsLoading ? (
    <div>...</div>
  ) : metrics.length === 0 ? (
    <div>No Metrics yet</div>
  ) : (
    <div className="h-full p-2 relative">
      {Object.entries(metricsByCategory).map(([key, data]) => (
        <div>
          <strong>{key}</strong>
          <div className="h-[200px] text-white">
            <ResponsiveLine
              data={[{ id: 'data', data }]}
              margin={{ top: 0, right: 50, bottom: 50, left: 60 }}
              xScale={{
                type: 'time',
                min: 'auto',
                max: 'auto',
              }}
              theme={{
                axis: {
                  ticks: {
                    text: {
                      stroke: '#999',
                    },
                  },
                  legend: {
                    text: {
                      stroke: '#999',
                    },
                  },
                },
                grid: {
                  line: {
                    stroke: '#888',
                  },
                },
              }}
              yScale={{
                type: 'linear',
                min: 'auto',
                max: 'auto',
                stacked: true,
                reverse: false,
              }}
              yFormat=" >-.2f"
              axisTop={null}
              axisRight={null}
              axisBottom={{
                tickSize: 5,
                tickPadding: 5,
                tickRotation: 0,
                legend: 'transportation',
                legendOffset: 36,
                legendPosition: 'middle',
              }}
              axisLeft={{
                tickSize: 5,
                tickPadding: 5,
                tickRotation: 0,
                legend: 'count',
                legendOffset: -40,
                legendPosition: 'middle',
              }}
              pointSize={3}
              pointColor={{ theme: 'background' }}
              pointBorderWidth={2}
              pointBorderColor={{ from: 'serieColor' }}
              pointLabelYOffset={-12}
              enableArea
              enableCrosshair
            />
          </div>
        </div>
      ))}
    </div>
  )
}
