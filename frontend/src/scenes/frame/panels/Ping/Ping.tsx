import { useEffect, useMemo, useRef, useState } from 'react'
import { useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { Button } from '../../../../components/Button'
import { apiFetch } from '../../../../utils/apiFetch'
import { NumberTextInput } from '../../../../components/NumberTextInput'
import { Select } from '../../../../components/Select'
import { TextInput } from '../../../../components/TextInput'

type PingMode = 'icmp' | 'http'

type PingResult = {
  id: number
  timestamp: string
  elapsedMs: number | null
  ok: boolean
  message: string
  mode: PingMode
  target: string
  status?: number | null
}

const MAX_RESULTS = 200

export function Ping() {
  const { frameId, frame } = useValues(frameLogic)
  const [intervalSeconds, setIntervalSeconds] = useState(1)
  const [pingMode, setPingMode] = useState<PingMode>('icmp')
  const [httpPath, setHttpPath] = useState('/ping')
  const [isRunning, setIsRunning] = useState(false)
  const [isPinging, setIsPinging] = useState(false)
  const [results, setResults] = useState<PingResult[]>([])
  const requestId = useRef(0)
  const timeoutId = useRef<number | null>(null)

  const intervalMs = useMemo(() => Math.max(1, intervalSeconds) * 1000, [intervalSeconds])
  const normalisedPath = useMemo(() => {
    const trimmed = (httpPath || '').trim() || '/ping'
    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  }, [httpPath])
  const targetLabel = useMemo(() => {
    const host = frame?.frame_host || 'frame'
    const port = frame?.frame_port ? `:${frame.frame_port}` : ''
    return pingMode === 'http' ? `${host}${port}${normalisedPath}` : host
  }, [frame, normalisedPath, pingMode])

  useEffect(() => {
    if (!isRunning) {
      if (timeoutId.current) {
        window.clearTimeout(timeoutId.current)
        timeoutId.current = null
      }
      setIsPinging(false)
      return
    }

    let cancelled = false

    const scheduleNext = (elapsed: number) => {
      if (cancelled) {
        return
      }
      const delay = Math.max(intervalMs - elapsed, 0)
      timeoutId.current = window.setTimeout(() => {
        void runPing()
      }, delay)
    }

    const runPing = async () => {
      const startedAt = Date.now()
      setIsPinging(true)
      const id = ++requestId.current
      let ok = false
      let message = ''
      let mode: PingMode = pingMode
      let target = targetLabel
      let status: number | null | undefined = null
      let payload: {
        elapsed_ms?: number | null
        ok?: boolean
        mode?: PingMode
        target?: string
        status?: number | null
        message?: string
      } | null = null
      let responseText: string | null = null

      try {
        const params = new URLSearchParams({ mode: pingMode })
        if (pingMode === 'http') {
          params.set('path', normalisedPath)
        }
        const response = await apiFetch(`/api/frames/${frameId}/ping?${params.toString()}`)
        const contentType = response.headers.get('content-type') ?? ''
        if (contentType.includes('application/json')) {
          try {
            payload = await response.json()
          } catch (error) {
            message = error instanceof Error ? error.message : String(error)
          }
        } else {
          responseText = (await response.text()).trim()
        }

        ok = payload?.ok ?? response.ok
        mode = (payload?.mode as PingMode) || pingMode
        target = payload?.target ?? targetLabel
        status = mode === 'http' ? (payload ? payload.status ?? null : response.status) : null
        if (payload?.message) {
          message = payload.message
        } else if (payload && Object.keys(payload).length > 0) {
          message = JSON.stringify(payload)
        } else {
          message = responseText || (ok ? 'pong' : `HTTP ${response.status}`)
        }
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }

      const elapsed = Date.now() - startedAt
      setResults((previous) => {
        const next = [
          {
            id,
            timestamp: new Date().toLocaleTimeString(),
            elapsedMs: payload?.elapsed_ms ?? elapsed,
            ok,
            message,
            mode,
            target,
            status,
          },
          ...previous,
        ]
        return next.slice(0, MAX_RESULTS)
      })
      setIsPinging(false)
      scheduleNext(elapsed)
    }

    void runPing()

    return () => {
      cancelled = true
      if (timeoutId.current) {
        window.clearTimeout(timeoutId.current)
        timeoutId.current = null
      }
    }
  }, [frameId, intervalMs, isRunning, pingMode, normalisedPath, targetLabel])

  useEffect(
    () => () => {
      if (timeoutId.current) {
        window.clearTimeout(timeoutId.current)
        timeoutId.current = null
      }
    },
    []
  )

  return (
    <div className="flex flex-col h-full space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex items-center gap-2">
          <Button
            color={isRunning ? 'secondary' : 'primary'}
            size="small"
            onClick={() => setIsRunning((value) => !value)}
          >
            {isRunning ? 'Stop' : 'Start'}
          </Button>
          {isPinging ? (
            <span className="text-sm text-gray-400 break-all">
              {pingMode === 'http' ? 'Requesting' : 'Pinging'} {targetLabel}...
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-3 items-center">
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
                  <span>{result.elapsedMs != null ? `${Math.round(result.elapsedMs)} ms` : '—'}</span>
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
