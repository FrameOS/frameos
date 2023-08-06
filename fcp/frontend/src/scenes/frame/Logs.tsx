import { useValues } from 'kea'
import { Box } from '../../components/Box'
import { H6 } from '../../components/H6'
import { frameLogic } from './frameLogic'
import clsx from 'clsx'

export function Logs() {
  const { logs, logsLoading } = useValues(frameLogic)
  return (
    <Box className="p-4">
      <H6 className="mb-4">Logs</H6>
      {logsLoading ? (
        '...'
      ) : logs.length === 0 ? (
        'No Logs yet'
      ) : (
        <div className="bg-black p-4">
          {logs.map((log) => (
            <div
              key={log.id}
              className={clsx({
                flex: true,
                '': log.type === 'stdout',
                'text-green-300': log.type === 'stdinfo',
                'text-red-300': log.type === 'stderr',
              })}
            >
              <span className="flex-0 mr-2 opacity-60">{log.timestamp}</span>
              <span className="flex-1">{log.line}</span>
            </div>
          ))}
        </div>
      )}
    </Box>
  )
}
