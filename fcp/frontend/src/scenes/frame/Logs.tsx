import { useValues } from 'kea'
import { Box } from '../../components/Box'
import { H6 } from '../../components/H6'
import { frameLogic } from './frameLogic'

export function Logs() {
  const { logs, logsLoading } = useValues(frameLogic)
  return (
    <Box className="p-4">
      <H6 className="mb-4">Logs</H6>
      {logsLoading
        ? '...'
        : logs.length === 0
        ? 'No Logs yet'
        : logs.map((log) => (
            <div key={log.id}>
              <span>{log.timestamp}</span>
              <span>{log.line}</span>
            </div>
          ))}
    </Box>
  )
}
