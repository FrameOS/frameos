import { useValues } from 'kea'
import clsx from 'clsx'
import { useRef, useState } from 'react'
import { logsLogic } from './logsLogic'
import { insertBreaks } from '../../../../utils/insertBreaks'
import { frameLogic } from '../../frameLogic'
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso'
import { Button } from '../../../../components/Button'

function formatTimestamp(isoTimestamp: string): string {
  const date = new Date(isoTimestamp)
  return `${date.getFullYear()}-${date.getMonth() + 1 < 10 ? '0' : ''}${date.getMonth() + 1}-${
    date.getDate() < 10 ? '0' : ''
  }${date.getDate()} ${date.getHours() < 10 ? '0' : ''}${date.getHours()}:${
    date.getMinutes() < 10 ? '0' : ''
  }${date.getMinutes()}:${date.getSeconds() < 10 ? '0' : ''}${date.getSeconds()}`
}

export function Logs() {
  const { frameId } = useValues(frameLogic)
  const { logs, logsLoading } = useValues(logsLogic({ frameId }))
  const [atBottom, setAtBottom] = useState(false)
  const virtuosoRef = useRef<VirtuosoHandle>(null)

  return logsLoading ? (
    <div>...</div>
  ) : logs.length === 0 ? (
    <div>No Logs yet</div>
  ) : (
    <div className="h-full bg-black p-2 relative">
      <Virtuoso
        className="h-full bg-black font-mono text-sm overflow-y-scroll overflow-x-hidden relative"
        ref={virtuosoRef}
        initialTopMostItemIndex={logs.length - 1}
        data={logs}
        followOutput={'auto'}
        atBottomStateChange={(bottom) => setAtBottom(bottom)}
        itemContent={(index, log) => {
          let logLine: string | JSX.Element = String(log.line)
          if (log.type === 'webhook') {
            try {
              const { event, timestamp, ...rest } = JSON.parse(log.line)
              logLine = (
                <>
                  <span className="text-yellow-600 mr-2">{event}</span>
                  {Object.entries(rest).map(([key, value]) => (
                    <span key={key} className="mr-2">
                      <span className="text-gray-400">{key}=</span>
                      <span>{insertBreaks(JSON.stringify(value))}</span>
                    </span>
                  ))}
                </>
              )
            } catch (e) {}
          }

          return (
            <div
              key={log.id}
              className={clsx('flex sm:flex-row flex-col', {
                'text-yellow-300': log.type === 'stdinfo',
                'text-red-300': log.type === 'stderr',
              })}
            >
              <div className="flex-0 mr-2 text-yellow-900 whitespace-nowrap">{formatTimestamp(log.timestamp)}</div>
              <div className="flex-1 break-words" style={{ wordBreak: 'break-word' }}>
                {logLine}
              </div>
            </div>
          )
        }}
      />
      {!atBottom && (
        <Button
          onClick={() => virtuosoRef.current?.scrollToIndex({ index: logs.length - 1, behavior: 'smooth' })}
          color="light-gray"
          size="small"
          className="absolute right-6 bottom-2"
        >
          Scroll to latest
        </Button>
      )}
    </div>
  )
}
