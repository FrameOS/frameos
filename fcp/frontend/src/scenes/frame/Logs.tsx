import { useValues } from 'kea'
import { Box } from '../../components/Box'
import { H6 } from '../../components/H6'
import { frameLogic } from './frameLogic'
import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'

export function Logs() {
  const { logs, logsLoading } = useValues(frameLogic)
  const [scrollDivRef, setScrollDivRef] = useState<HTMLDivElement | null>(null)

  useEffect(() => {
    if (scrollDivRef) {
      scrollDivRef.scrollTop = scrollDivRef.scrollHeight
    }
  }, [scrollDivRef, logs])

  return (
    <Box className="p-4">
      <H6 className="mb-4">Logs</H6>
      {logsLoading ? (
        '...'
      ) : logs.length === 0 ? (
        'No Logs yet'
      ) : (
        <div
          className="bg-black p-4 font-mono text-sm overflow-y-scroll overflow-x-hidden"
          ref={setScrollDivRef}
          style={{ maxHeight: '500px' }}
        >
          {logs.map((log) => (
            <div
              key={log.id}
              className={clsx('flex items-end', {
                'text-yellow-300': log.type === 'stdinfo',
                'text-red-300': log.type === 'stderr',
              })}
            >
              <span className="flex-0 mr-2 text-yellow-900">{log.timestamp.replace('T', ' ')}</span>
              <span className="flex-1">{log.line}</span>
            </div>
          ))}
        </div>
      )}
    </Box>
  )
}
