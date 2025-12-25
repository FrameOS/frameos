import { useEffect, useMemo, useRef, useState } from 'react'
import { useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { Button } from '../../../../components/Button'
import { apiFetch } from '../../../../utils/apiFetch'
import { NumberTextInput } from '../../../../components/NumberTextInput'

type PingResult = {
  id: number
  timestamp: string
  elapsedMs: number
  ok: boolean
  message: string
}

const MAX_RESULTS = 200

export function Ping() {
  const { frameId } = useValues(frameLogic)
  const [intervalSeconds, setIntervalSeconds] = useState(1)
  const [isRunning, setIsRunning] = useState(false)
  const [isPinging, setIsPinging] = useState(false)
  const [results, setResults] = useState<PingResult[]>([])
  const requestId = useRef(0)
  const timeoutId = useRef<number | null>(null)

  const intervalMs = useMemo(() => Math.max(1, intervalSeconds) * 1000, [intervalSeconds])

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

      try {
        const response = await apiFetch(`/api/frames/${frameId}/ping`)
        const contentType = response.headers.get('content-type') ?? ''
        if (response.ok) {
          ok = true
          if (contentType.includes('application/json')) {
            const payload = await response.json()
            message = JSON.stringify(payload)
          } else {
            message = (await response.text()).trim() || 'pong'
          }
        } else if (contentType.includes('application/json')) {
          const payload = await response.json()
          message = payload.detail ? String(payload.detail) : JSON.stringify(payload)
        } else {
          message = (await response.text()).trim() || `HTTP ${response.status}`
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
            elapsedMs: elapsed,
            ok,
            message,
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
  }, [frameId, intervalMs, isRunning])

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
          {isPinging ? <span className="text-sm text-gray-400">Waiting for response…</span> : null}
        </div>
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

      <div className="flex-1 overflow-y-auto rounded border border-gray-800 bg-black/60 p-3 text-sm">
        {results.length === 0 ? (
          <div className="text-gray-400">No pings yet.</div>
        ) : (
          <ul className="space-y-2">
            {results.map((result) => (
              <li key={result.id} className="flex flex-col gap-1 rounded border border-gray-800 bg-black/80 p-2">
                <div className="flex items-center justify-between text-xs text-gray-400">
                  <span>{result.timestamp}</span>
                  <span>{result.elapsedMs} ms</span>
                </div>
                <div className={result.ok ? 'text-green-300' : 'text-red-300'}>
                  {result.ok ? 'pong' : 'error'}: {result.message || 'No response body'}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
