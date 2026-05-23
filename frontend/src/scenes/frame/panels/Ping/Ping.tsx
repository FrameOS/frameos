import { useActions, useValues } from 'kea'
import clsx from 'clsx'
import type { ReactNode } from 'react'
import { CheckCircleIcon, PauseIcon, PlayIcon, SignalIcon, XCircleIcon } from '@heroicons/react/24/outline'
import { frameLogic } from '../../frameLogic'
import { NumberTextInput } from '../../../../components/NumberTextInput'
import { TextInput } from '../../../../components/TextInput'
import { formatMs, pingLogic, PingMode, PingResult } from './pingLogic'

interface PingProps {
  scrollContainer?: boolean
}

function primaryLatency(result: PingResult | null | undefined): number | null {
  if (!result) {
    return null
  }
  return result.icmpTimeMs ?? result.clientElapsedMs ?? result.serverElapsedMs ?? null
}

function latencyLabel(result: PingResult | null | undefined): string {
  const latency = primaryLatency(result)
  return latency === null ? 'No sample' : `${formatMs(latency, latency < 10 ? 1 : 0)} ms`
}

function latencyDetail(result: PingResult | null | undefined): string {
  if (!result) {
    return 'Waiting for first check'
  }
  if (result.mode === 'icmp' && result.icmpTimeMs !== null && result.clientElapsedMs !== null) {
    return `${formatMs(result.clientElapsedMs, 0)} ms browser round trip`
  }
  if (result.serverElapsedMs !== null && result.clientElapsedMs !== null) {
    return `${formatMs(result.serverElapsedMs, 0)} ms server measured`
  }
  return result.mode === 'http' ? 'HTTP round trip' : 'Host reply time'
}

function latencyTone(value: number | null): 'good' | 'warning' | 'danger' | 'neutral' {
  if (value === null) {
    return 'neutral'
  }
  if (value >= 1000) {
    return 'danger'
  }
  if (value >= 250) {
    return 'warning'
  }
  return 'good'
}

function toneClasses(tone: 'good' | 'warning' | 'danger' | 'neutral'): { text: string; dot: string; bg: string } {
  if (tone === 'good') {
    return { text: 'text-emerald-500', dot: 'bg-emerald-500', bg: 'bg-emerald-500/10' }
  }
  if (tone === 'warning') {
    return { text: 'text-amber-500', dot: 'bg-amber-500', bg: 'bg-amber-500/10' }
  }
  if (tone === 'danger') {
    return { text: 'text-red-500', dot: 'bg-red-500', bg: 'bg-red-500/10' }
  }
  return { text: 'frameos-primary-text', dot: 'frameos-primary-fill', bg: 'bg-slate-500/10' }
}

function MetricCard({
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  label: string
  value: string
  detail: string
  tone?: 'good' | 'warning' | 'danger' | 'neutral'
}): JSX.Element {
  const colors = toneClasses(tone)

  return (
    <div className="frame-tool-card rounded-[22px] p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="frame-tool-muted text-xs font-semibold uppercase tracking-wide">{label}</div>
        <span className={clsx('h-2.5 w-2.5 rounded-full', colors.dot)} />
      </div>
      <div className={clsx('mt-3 truncate text-2xl font-bold tracking-normal', colors.text)}>{value}</div>
      <div className="frame-tool-muted mt-1 truncate text-sm">{detail}</div>
    </div>
  )
}

function ModeButton({
  active,
  disabled,
  children,
  onClick,
}: {
  active: boolean
  disabled?: boolean
  children: ReactNode
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        'rounded-full px-3 py-1.5 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-50',
        active ? 'frameos-primary-active text-white' : 'frameos-secondary-button bg-white/75 text-slate-700'
      )}
    >
      {children}
    </button>
  )
}

function ResultRow({ result }: { result: PingResult }): JSX.Element {
  const tone = result.ok ? latencyTone(primaryLatency(result)) : 'danger'
  const colors = toneClasses(tone)
  const Icon = result.ok ? CheckCircleIcon : XCircleIcon

  return (
    <li className="frame-tool-row rounded-[20px] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex items-start gap-3">
          <span className={clsx('mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full', colors.bg)}>
            <Icon className={clsx('h-5 w-5', colors.text)} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold">{result.ok ? 'Reply' : 'Error'}</span>
              <span className="frame-tool-muted rounded-full bg-slate-500/10 px-2 py-0.5 text-xs font-semibold">
                {result.mode === 'http' ? 'HTTP' : 'ICMP'}
              </span>
              {result.status ? (
                <span className="frame-tool-muted rounded-full bg-slate-500/10 px-2 py-0.5 text-xs font-semibold">
                  {result.status}
                </span>
              ) : null}
            </div>
            <div className="frame-tool-muted mt-1 break-all text-xs">{result.target}</div>
          </div>
        </div>
        <div className="text-right">
          <div className={clsx('text-lg font-bold tracking-normal', colors.text)}>{latencyLabel(result)}</div>
          <div className="frame-tool-muted text-xs">{result.timestamp}</div>
        </div>
      </div>
      <div className="mt-3 rounded-2xl bg-slate-500/10 px-3 py-2 text-sm">{result.message || 'No response body'}</div>
    </li>
  )
}

export function Ping({ scrollContainer = true }: PingProps = {}) {
  const { frameId } = useValues(frameLogic)
  const { intervalSeconds, pingMode, httpPath, isFrameAdminMode, isRunning, isPinging, results, targetLabel } =
    useValues(pingLogic({ frameId }))
  const { setIntervalSeconds, setPingMode, setHttpPath, toggleRunning } = useActions(pingLogic({ frameId }))
  const activeMode: PingMode = isFrameAdminMode ? 'http' : pingMode
  const latestResult = results[0] ?? null
  const successfulResults = results.filter((result) => result.ok)
  const successRate = results.length ? Math.round((successfulResults.length / results.length) * 100) : null
  const latencySamples = results.map(primaryLatency).filter((value): value is number => value !== null)
  const averageLatency = latencySamples.length
    ? latencySamples.reduce((total, value) => total + value, 0) / latencySamples.length
    : null
  const currentTone = latestResult
    ? latestResult.ok
      ? latencyTone(primaryLatency(latestResult))
      : 'danger'
    : 'neutral'
  const statusLabel = isRunning ? (isPinging ? 'Checking' : 'Monitoring') : results.length ? 'Paused' : 'Idle'

  return (
    <div className={clsx('frame-tool-panel @container flex flex-col gap-5', scrollContainer && 'h-full min-h-0')}>
      <section className="frame-tool-card overflow-hidden rounded-[28px]">
        <div className="flex flex-col gap-5 p-5 @3xl:flex-row @3xl:items-center @3xl:justify-between">
          <div className="min-w-0">
            <div className="frame-tool-muted text-xs font-semibold uppercase tracking-wide">Connectivity</div>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <h2 className="truncate text-2xl font-bold tracking-normal">Ping monitor</h2>
              <span
                className={clsx(
                  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold',
                  isRunning ? 'bg-emerald-500/10 text-emerald-500' : 'bg-slate-500/10 frame-tool-muted'
                )}
              >
                <span
                  className={clsx(
                    'h-2 w-2 rounded-full',
                    isRunning ? (isPinging ? 'animate-pulse bg-emerald-400' : 'bg-emerald-500') : 'bg-slate-400'
                  )}
                />
                {statusLabel}
              </span>
            </div>
            <div className="frame-tool-muted mt-2 break-all text-sm">
              {activeMode === 'http' ? 'Request target' : 'Host target'}: {targetLabel}
            </div>
          </div>
          <button
            type="button"
            onClick={() => toggleRunning()}
            className={clsx(
              'inline-flex h-12 shrink-0 items-center justify-center gap-2 rounded-full px-5 text-sm font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
              isRunning
                ? 'ping-stop-button frameos-secondary-button'
                : 'frameos-primary-action text-white hover:shadow-lg'
            )}
          >
            {isRunning ? <PauseIcon className="h-5 w-5" /> : <PlayIcon className="h-5 w-5" />}
            {isRunning ? 'Stop monitor' : 'Start monitor'}
          </button>
        </div>

        <div className="border-t border-slate-500/20 px-5 py-4">
          <div className="grid gap-3 @3xl:grid-cols-[auto_1fr_auto] @3xl:items-end">
            <div>
              <div className="frame-tool-muted mb-2 text-xs font-semibold uppercase tracking-wide">Mode</div>
              <div className="flex flex-wrap gap-2">
                <ModeButton
                  active={activeMode === 'icmp'}
                  disabled={isFrameAdminMode}
                  onClick={() => setPingMode('icmp')}
                >
                  ICMP
                </ModeButton>
                <ModeButton
                  active={activeMode === 'http'}
                  disabled={isFrameAdminMode}
                  onClick={() => setPingMode('http')}
                >
                  HTTP
                </ModeButton>
              </div>
            </div>
            <div className={clsx(activeMode === 'http' ? 'block' : 'hidden @3xl:block')}>
              <label
                className="frame-tool-muted mb-2 block text-xs font-semibold uppercase tracking-wide"
                htmlFor="ping-path"
              >
                Path
              </label>
              <TextInput
                id="ping-path"
                className="min-h-10"
                placeholder="/ping"
                value={httpPath}
                onChange={(value) => setHttpPath(value)}
                disabled={activeMode !== 'http'}
              />
            </div>
            <div>
              <label
                className="frame-tool-muted mb-2 block text-xs font-semibold uppercase tracking-wide"
                htmlFor="ping-interval"
              >
                Interval
              </label>
              <div className="flex items-center gap-2">
                <NumberTextInput
                  id="ping-interval"
                  min={1}
                  step={1}
                  className="min-h-10 !w-20"
                  value={intervalSeconds}
                  onChange={(value) => {
                    setIntervalSeconds(Number.isFinite(value) ? Math.max(1, value ?? 1) : 1)
                  }}
                />
                <span className="frame-tool-muted text-sm">sec</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-3 @3xl:grid-cols-4">
        <MetricCard
          label="Latest"
          value={latencyLabel(latestResult)}
          detail={latestResult ? latencyDetail(latestResult) : 'No sample yet'}
          tone={currentTone}
        />
        <MetricCard
          label="Average"
          value={averageLatency === null ? 'No sample' : `${formatMs(averageLatency, averageLatency < 10 ? 1 : 0)} ms`}
          detail={`${latencySamples.length} latency ${latencySamples.length === 1 ? 'sample' : 'samples'}`}
          tone={latencyTone(averageLatency)}
        />
        <MetricCard
          label="Success"
          value={successRate === null ? 'No sample' : `${successRate}%`}
          detail={`${successfulResults.length} of ${results.length} replies`}
          tone={
            successRate === null ? 'neutral' : successRate >= 95 ? 'good' : successRate >= 75 ? 'warning' : 'danger'
          }
        />
        <MetricCard
          label="History"
          value={String(results.length)}
          detail={activeMode === 'http' ? 'HTTP checks' : 'ICMP checks'}
          tone="neutral"
        />
      </section>

      <section
        className={clsx('min-h-0 rounded-[24px]', scrollContainer ? 'flex-1 overflow-y-auto pr-1' : 'overflow-visible')}
      >
        {results.length === 0 ? (
          <div
            className={clsx(
              'frame-tool-card flex min-h-56 items-center justify-center rounded-[24px] px-6 text-center',
              scrollContainer && 'h-full'
            )}
          >
            <div>
              <SignalIcon className="frame-tool-muted mx-auto mb-4 h-10 w-10" />
              <div className="text-lg font-semibold">No checks yet</div>
              <div className="frame-tool-muted mt-1 text-sm">Start the monitor to collect connectivity samples.</div>
            </div>
          </div>
        ) : (
          <ol className="space-y-3">
            {results.map((result) => (
              <ResultRow key={result.id} result={result} />
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}
