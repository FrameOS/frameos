import { useActions, useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { Button } from '../../../../components/Button'
import { NumberTextInput } from '../../../../components/NumberTextInput'
import { Select } from '../../../../components/Select'
import { TextInput } from '../../../../components/TextInput'
import { formatMs, pingLogic, PingMode } from './pingLogic'

export function Ping() {
  const { frameId } = useValues(frameLogic)
  const { intervalSeconds, pingMode, httpPath, isFrameAdminMode, isRunning, isPinging, results, targetLabel } =
    useValues(pingLogic({ frameId }))
  const { setIntervalSeconds, setPingMode, setHttpPath, toggleRunning } = useActions(pingLogic({ frameId }))
  const activeMode: PingMode = isFrameAdminMode ? 'http' : pingMode

  return (
    <div className="flex flex-col h-full space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex items-center gap-2">
          <Button color={isRunning ? 'secondary' : 'primary'} size="small" onClick={() => toggleRunning()}>
            {isRunning ? 'Stop' : 'Start'}
          </Button>
          {isPinging ? (
            <span className="text-sm text-gray-400 break-all">
              {activeMode === 'http' ? 'Requesting' : 'Pinging'} {targetLabel}...
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-3 items-center">
          {!isFrameAdminMode ? (
            <>
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium text-gray-300" htmlFor="ping-mode">
                  Mode:
                </label>
                <Select
                  id="ping-mode"
                  className="w-44"
                  value={pingMode}
                  onChange={(value) => setPingMode((value as PingMode) || 'icmp')}
                  options={[
                    { value: 'icmp', label: 'Host ping (ICMP)' },
                    { value: 'http', label: 'HTTP ping (/ping)' },
                  ]}
                />
              </div>
              {pingMode === 'http' ? (
                <div className="flex items-center gap-2">
                  <label className="text-sm font-medium text-gray-300" htmlFor="ping-path">
                    Path:
                  </label>
                  <TextInput
                    id="ping-path"
                    className="!w-36"
                    placeholder="/ping"
                    value={httpPath}
                    onChange={(value) => setHttpPath(value)}
                  />
                </div>
              ) : null}
            </>
          ) : null}
          <div className="flex flex-row gap-2 items-center">
            <label className="text-sm font-medium text-gray-300" htmlFor="ping-interval">
              Interval:
            </label>
            <NumberTextInput
              id="ping-interval"
              min={1}
              step={1}
              className="!w-14 rounded bg-black text-white p-2 focus:outline-none"
              value={intervalSeconds}
              onChange={(value) => {
                setIntervalSeconds(Number.isFinite(value) ? Math.max(1, value ?? 1) : 1)
              }}
            />
            <label className="text-sm font-medium text-gray-300" htmlFor="ping-interval">
              seconds
            </label>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto rounded border border-gray-800 bg-black/60 p-3 text-sm">
        {results.length === 0 ? (
          <div className="text-gray-400">No pings yet.</div>
        ) : (
          <ul className="space-y-2">
            {results.map((result) => (
              <li key={result.id} className="flex flex-col gap-1 rounded border border-gray-800 bg-black/80 p-2">
                <div className="flex items-center justify-between text-xs text-gray-400">
                  <span>
                    {result.timestamp} · {result.mode === 'http' ? 'HTTP' : 'ICMP'} · {result.target}
                    {result.status ? ` (status ${result.status})` : ''}
                  </span>
                  <span className="text-right">
                    {result.mode === 'icmp' && result.icmpTimeMs != null && result.clientElapsedMs != null ? (
                      <span className="inline-flex items-center gap-1">
                        <span className="font-semibold text-emerald-300" title="ICMP reply time reported by the host">
                          {formatMs(result.icmpTimeMs, 3)} ms
                        </span>
                        <span className="text-gray-500">/</span>
                        <span className="text-sky-300" title="Browser round-trip time (request/response)">
                          {formatMs(result.clientElapsedMs, 0)} ms
                        </span>
                      </span>
                    ) : result.clientElapsedMs != null ? (
                      <span title="Browser round-trip time (request/response)">
                        {formatMs(result.clientElapsedMs, 0)} ms
                      </span>
                    ) : result.serverElapsedMs != null ? (
                      <span title="Server-measured round-trip time">{formatMs(result.serverElapsedMs, 0)} ms</span>
                    ) : (
                      '—'
                    )}
                  </span>
                </div>
                <div className={result.ok ? 'text-green-300' : 'text-red-300'}>
                  {result.ok ? 'reply' : 'error'}: {result.message || 'No response body'}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
