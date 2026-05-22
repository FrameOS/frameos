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
    <div className="frame-tool-panel flex h-full flex-col space-y-4">
      <div className="frame-tool-card flex flex-col gap-3 rounded-[22px] p-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex items-center gap-2">
          <Button color={isRunning ? 'secondary' : 'primary'} size="small" onClick={() => toggleRunning()}>
            {isRunning ? 'Stop' : 'Start'}
          </Button>
          {isPinging ? (
            <span className="frame-tool-muted break-all text-sm">
              {activeMode === 'http' ? 'Requesting' : 'Pinging'} {targetLabel}...
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-3 items-center">
          {!isFrameAdminMode ? (
            <>
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium frame-tool-muted" htmlFor="ping-mode">
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
                  <label className="text-sm font-medium frame-tool-muted" htmlFor="ping-path">
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
            <label className="text-sm font-medium frame-tool-muted" htmlFor="ping-interval">
              Interval:
            </label>
            <NumberTextInput
              id="ping-interval"
              min={1}
              step={1}
              className="!w-16 rounded-xl p-2 focus:outline-none"
              value={intervalSeconds}
              onChange={(value) => {
                setIntervalSeconds(Number.isFinite(value) ? Math.max(1, value ?? 1) : 1)
              }}
            />
            <label className="text-sm font-medium frame-tool-muted" htmlFor="ping-interval">
              seconds
            </label>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto rounded-[22px] text-sm">
        {results.length === 0 ? (
          <div className="frame-tool-card flex h-full items-center justify-center rounded-[22px] frame-tool-muted">
            No pings yet.
          </div>
        ) : (
          <ul className="space-y-2">
            {results.map((result) => (
              <li key={result.id} className="frame-tool-card flex flex-col gap-1 rounded-2xl p-3">
                <div className="frame-tool-muted flex items-center justify-between text-xs">
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
