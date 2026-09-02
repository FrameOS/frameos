import { Popover, Transition } from '@headlessui/react'
import { useActions, useValues } from 'kea'
import { A } from 'kea-router'
import clsx from 'clsx'
import ReactDOM from 'react-dom'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { usePopper } from 'react-popper'

import { BatteryIndicator, batteryTitle, batteryTone, type BatteryTone } from '../../components/BatteryIndicator'
import type { FrameType } from '../../types'
import {
  analyzeBattery,
  batteryForecast,
  forecastCycleOptions,
  formatCycle,
  formatRemaining,
  nearestCycleOption,
  type BatteryAnalysis,
  type BatteryForecast,
  type BatterySample,
} from '../../utils/batteryForecast'
import { formatFrameRelativeTime } from '../../decorators/frame'
import { metricCardHash } from '../frame/panels/Metrics/metricsLogic'
import { urls } from '../../urls'
import { frameBatteryLogic } from './frameBatteryLogic'

/**
 * The battery popup: everything the cloud knows about a frame's cell —
 * charge, voltage, power source, how often it wakes — its charge over the
 * last two weeks, and how long it will last: at the cadence it is on now,
 * and at any other the slider picks (utils/batteryForecast.ts).
 *
 * The trigger is one button around the whole glyph + number (no dead
 * whitespace between them), in three looks: `panel` is a bordered control
 * matching the sidebar's frame selector and actions menu, `list` is
 * invisible — the frames list already reads busy — with a padded hit area,
 * and `chip` takes its look from the header metric chips around it.
 */
export type BatteryButtonVariant = 'panel' | 'list' | 'chip'

const buttonVariantClassName: Record<BatteryButtonVariant, string> = {
  panel:
    'frameos-form-control flex h-10 shrink-0 items-center rounded-xl border border-slate-200 bg-white px-2.5 shadow-none transition hover:bg-slate-50',
  list: '-m-1.5 flex shrink-0 items-center rounded-md p-1.5 transition hover:bg-slate-500/10',
  chip: '',
}

const toneFill: Record<BatteryTone, string> = {
  full: '#10b981',
  ok: '#10b981',
  low: '#f59e0b',
  critical: '#ef4444',
}

const toneLabel: Record<BatteryTone, string> = {
  full: 'Full',
  ok: 'Good',
  low: 'Getting low',
  critical: 'Charge soon',
}

export function FrameBatteryPopover({
  frame,
  percent,
  variant,
  size = 'md',
  className,
  children,
}: {
  frame: FrameType
  percent: number
  variant: BatteryButtonVariant
  size?: 'sm' | 'md'
  className?: string
  /** The trigger's content; defaults to the glyph + number. */
  children?: ReactNode
}): JSX.Element {
  const [referenceElement, setReferenceElement] = useState<HTMLButtonElement | null>(null)
  const [popperElement, setPopperElement] = useState<HTMLDivElement | null>(null)
  const { styles, attributes } = usePopper(referenceElement, popperElement, {
    strategy: 'fixed',
    placement: 'bottom-end',
    modifiers: [
      { name: 'offset', options: { offset: [0, 8] } },
      { name: 'flip', options: { fallbackPlacements: ['bottom-start', 'top-end', 'top-start'], padding: 8 } },
      { name: 'preventOverflow', options: { padding: 8, altAxis: true, tether: false } },
      // adaptive right/bottom anchoring miscomputes against the #popper portal; always anchor top-left
      { name: 'computeStyles', options: { adaptive: false } },
    ],
  })
  const portalTarget = typeof document === 'undefined' ? null : document.querySelector('#popper')

  return (
    <Popover className="contents">
      {({ open }) => (
        <>
          <Popover.Button
            ref={setReferenceElement}
            type="button"
            title={`${batteryTitle(percent)} — click for details`}
            aria-label={`${batteryTitle(percent)}. Battery details.`}
            data-testid="battery-button"
            data-battery-variant={variant}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            className={clsx(
              'cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
              buttonVariantClassName[variant],
              className
            )}
          >
            {children ?? <BatteryIndicator percent={percent} size={size} title="" />}
          </Popover.Button>
          {portalTarget
            ? ReactDOM.createPortal(
                // opacity only: a transform on this wrapper would become the containing
                // block for the fixed-positioned panel and break popper's coordinates
                <Transition
                  show={open}
                  enter="transition ease-out duration-100"
                  enterFrom="opacity-0"
                  enterTo="opacity-100"
                  leave="transition ease-in duration-75"
                  leaveFrom="opacity-100"
                  leaveTo="opacity-0"
                >
                  <Popover.Panel
                    static
                    ref={setPopperElement}
                    style={styles.popper}
                    {...attributes.popper}
                    className="frameos-tooltip-panel z-50 w-[22.5rem] max-w-[calc(100vw-1rem)] rounded-xl p-3.5 text-left text-xs focus:outline-none"
                    data-testid="battery-popover"
                  >
                    {open ? <BatteryPanel frame={frame} percent={percent} /> : null}
                  </Popover.Panel>
                </Transition>,
                portalTarget
              )
            : null}
        </>
      )}
    </Popover>
  )
}

function formatDate(time: number, withTime = false): string {
  const date = new Date(time)
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}),
  })
}

function formatDrain(perDay: number): string {
  if (perDay >= 10) {
    return `${Math.round(perDay)}% / day`
  }
  if (perDay >= 1) {
    return `${perDay.toFixed(1)}% / day`
  }
  return `${perDay.toFixed(2)}% / day`
}

function BatteryPanel({ frame, percent }: { frame: FrameType; percent: number }): JSX.Element {
  const logic = frameBatteryLogic({ frameId: frame.id })
  const { sortedBatteryHistory, batteryHistoryLoading, batteryHistoryLoadedAt, selectedCycleSeconds } = useValues(logic)
  const { ensureBatteryHistory, setSelectedCycleSeconds } = useActions(logic)

  useEffect(() => {
    ensureBatteryHistory()
  }, [ensureBatteryHistory])

  const now = Date.now()
  const analysis = useMemo(() => analyzeBattery(sortedBatteryHistory, frame), [sortedBatteryHistory, frame])
  const latest = analysis.latest
  const shownPercent = latest?.percent ?? percent
  const tone = batteryTone(shownPercent)
  const cycleOptions = useMemo(
    () => forecastCycleOptions(analysis.cadence.cycleSeconds),
    [analysis.cadence.cycleSeconds]
  )
  const observedCycle = nearestCycleOption(cycleOptions, analysis.cadence.cycleSeconds)
  const selectedCycle =
    selectedCycleSeconds !== null && cycleOptions.includes(selectedCycleSeconds) ? selectedCycleSeconds : observedCycle
  const currentForecast = batteryForecast(analysis, observedCycle, now)
  const selectedForecast =
    selectedCycle === observedCycle ? currentForecast : batteryForecast(analysis, selectedCycle, now)
  const loading = batteryHistoryLoading && batteryHistoryLoadedAt === null
  const pluggedIn = latest?.onBattery === false

  return (
    <div className="flex flex-col gap-3" data-battery-tone={tone}>
      <div className="flex items-center gap-3">
        <BatteryGraphic percent={shownPercent} tone={tone} pluggedIn={pluggedIn} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold leading-none tabular-nums">{shownPercent}%</span>
            <span className="text-[11px] font-semibold" style={{ color: toneFill[tone] }}>
              {pluggedIn ? 'Plugged in' : toneLabel[tone]}
            </span>
          </div>
          <div className="frameos-muted mt-1 truncate text-[11px]">
            {latest?.millivolts !== null && latest?.millivolts !== undefined
              ? `${(latest.millivolts / 1000).toFixed(2)} V · `
              : ''}
            {latest ? `read ${formatFrameRelativeTime(latest.t, now) ?? 'just now'}` : 'from the last check-in'}
          </div>
        </div>
      </div>

      <BatteryFacts frame={frame} analysis={analysis} loading={loading} />

      <BatteryChart
        analysis={analysis}
        currentForecast={currentForecast}
        selectedForecast={selectedForecast}
        now={now}
      />

      <BatteryForecastControls
        analysis={analysis}
        loading={loading}
        cycleOptions={cycleOptions}
        observedCycle={observedCycle}
        selectedCycle={selectedCycle}
        currentForecast={currentForecast}
        selectedForecast={selectedForecast}
        onSelectCycle={(cycle) => setSelectedCycleSeconds(cycle === observedCycle ? null : cycle)}
      />

      <div className="frameos-muted flex items-center justify-between gap-2 border-t border-slate-500/15 pt-2 text-[11px]">
        <A
          href={urls.frame(frame.id, 'metrics') + metricCardHash('batteryPercent')}
          className="font-semibold underline-offset-2 hover:underline"
        >
          Open metrics
        </A>
        <A href={urls.frame(frame.id, 'settings')} className="font-semibold underline-offset-2 hover:underline">
          Power settings
        </A>
      </div>
    </div>
  )
}

/** A large battery glyph, filled to `percent` in the charge band's colour. */
function BatteryGraphic({ percent, tone, pluggedIn }: { percent: number; tone: BatteryTone; pluggedIn: boolean }) {
  // viewBox 64×32: body 56×28 at (1,2) with a 2px stroke, cap 5×12 on the right, fill inset by 4.
  const fillWidth = Math.max(0, (48 * percent) / 100)
  return (
    <svg viewBox="0 0 64 32" className="h-9 w-[4.5rem] shrink-0" aria-hidden data-testid="battery-graphic">
      <rect
        x="1"
        y="2"
        width="56"
        height="28"
        rx="5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        opacity="0.55"
      />
      <rect x="59" y="10" width="4" height="12" rx="1.5" fill="currentColor" opacity="0.55" />
      <rect x="5" y="6" width={fillWidth} height="20" rx="2.5" fill={toneFill[tone]} />
      {pluggedIn ? (
        <path
          d="M33 4 L23 18 L30 18 L27 28 L38 13 L31 13 Z"
          fill="#ffffff"
          stroke="#0f172a"
          strokeWidth="1"
          strokeLinejoin="round"
        />
      ) : null}
    </svg>
  )
}

function Fact({ label, value, title }: { label: string; value: ReactNode; title?: string }): JSX.Element {
  return (
    <div className="min-w-0" title={title}>
      <div className="frameos-muted text-[10px] font-semibold uppercase tracking-wide">{label}</div>
      <div className="truncate text-[12px] font-medium tabular-nums">{value}</div>
    </div>
  )
}

function BatteryFacts({
  frame,
  analysis,
  loading,
}: {
  frame: FrameType
  analysis: BatteryAnalysis
  loading: boolean
}): JSX.Element {
  const { cadence, segment, drainPerDay, samples, misreadCount, latest } = analysis
  const placeholder = loading ? '…' : '—'
  const configuredInterval = Number(frame.interval) > 0 ? Number(frame.interval) : null
  const wakeCause = latest?.wakeCause ? ` · woke by ${latest.wakeCause}` : ''
  return (
    <div
      className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg bg-slate-500/[0.07] px-3 py-2"
      data-testid="battery-facts"
    >
      <Fact
        label="Wakes up"
        value={cadence.cycleSeconds !== null ? `every ${formatCycle(cadence.cycleSeconds)}` : placeholder}
        title={
          configuredInterval
            ? `Measured from the check-ins. The frame's render interval is set to ${formatCycle(configuredInterval)}.`
            : 'Measured from the check-ins.'
        }
      />
      <Fact
        label="Awake per wake"
        value={cadence.awakeSeconds !== null ? `${Math.round(cadence.awakeSeconds)} s${wakeCause}` : placeholder}
        title="How long the frame stays on each time it wakes: boot, Wi-Fi, render, refresh."
      />
      <Fact
        label="Drain"
        value={drainPerDay !== null ? formatDrain(drainPerDay) : placeholder}
        title={segment ? `Fitted to the readings since ${formatDate(segment.start, true)}.` : undefined}
      />
      <Fact
        label="Since last charge"
        value={
          segment
            ? `${formatDate(segment.start)} · ${segment.startPercent}% → ${segment.endPercent}%`
            : samples.length > 0
            ? `${samples.length} reading${samples.length === 1 ? '' : 's'}`
            : placeholder
        }
        title={
          segment
            ? `${segment.samples.length} readings on battery${
                misreadCount ? `, ${misreadCount} misread${misreadCount === 1 ? '' : 's'} ignored` : ''
              }`
            : undefined
        }
      />
    </div>
  )
}

const chartWidth = 324
const chartHeight = 118
const chartMargin = { top: 8, right: 6, bottom: 18, left: 30 }
const maxHistoryPoints = 300

function downsample(samples: BatterySample[]): BatterySample[] {
  if (samples.length <= maxHistoryPoints) {
    return samples
  }
  const step = samples.length / maxHistoryPoints
  const picked: BatterySample[] = []
  for (let i = 0; i < maxHistoryPoints; i++) {
    picked.push(samples[Math.floor(i * step)])
  }
  picked.push(samples[samples.length - 1])
  return picked
}

/**
 * Charge over time, the history drawn solid and the forecasts dashed from
 * the newest reading down to empty: the current cadence in the charge
 * band's colour, the slider's pick in blue. A day past the further forecast
 * (or a day of nothing) is the right edge, so the axis always has room.
 */
function BatteryChart({
  analysis,
  currentForecast,
  selectedForecast,
  now,
}: {
  analysis: BatteryAnalysis
  currentForecast: BatteryForecast | null
  selectedForecast: BatteryForecast | null
  now: number
}): JSX.Element {
  const points = useMemo(() => downsample(analysis.samples), [analysis.samples])
  const latest = analysis.latest
  const innerWidth = chartWidth - chartMargin.left - chartMargin.right
  const innerHeight = chartHeight - chartMargin.top - chartMargin.bottom

  const historyStart = points.length > 0 ? Math.min(points[0].t, now - 24 * 3_600_000) : now - 24 * 3_600_000
  const forecastEnd = Math.max(
    now + 24 * 3_600_000,
    ...[currentForecast, selectedForecast]
      .filter((forecast): forecast is BatteryForecast => forecast !== null)
      .map((forecast) => Math.min(forecast.emptyAt, now + 90 * 24 * 3_600_000))
  )
  const x = (t: number): number => chartMargin.left + ((t - historyStart) / (forecastEnd - historyStart)) * innerWidth
  const y = (p: number): number => chartMargin.top + (1 - p / 100) * innerHeight

  const historyPath = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${x(point.t).toFixed(1)},${y(point.percent).toFixed(1)}`)
    .join(' ')
  const forecastPath = (forecast: BatteryForecast | null): string | null => {
    if (!forecast || !latest) {
      return null
    }
    const endT = Math.min(forecast.emptyAt, forecastEnd)
    const endP = endT >= forecast.emptyAt ? 0 : latest.percent * (1 - (endT - latest.t) / (forecast.emptyAt - latest.t))
    return `M${x(latest.t).toFixed(1)},${y(latest.percent).toFixed(1)} L${x(endT).toFixed(1)},${y(
      Math.max(0, endP)
    ).toFixed(1)}`
  }
  const currentPath = forecastPath(currentForecast)
  const selectedPath = selectedForecast !== currentForecast ? forecastPath(selectedForecast) : null

  // Date ticks: one every whole day that fits, thinned to at most six.
  const dayMs = 24 * 3_600_000
  const spanDays = (forecastEnd - historyStart) / dayMs
  const tickEvery = Math.max(1, Math.ceil(spanDays / 6))
  const ticks: number[] = []
  const firstDay = new Date(historyStart)
  firstDay.setHours(0, 0, 0, 0)
  for (let t = firstDay.getTime(); t <= forecastEnd; t += dayMs * tickEvery) {
    if (t >= historyStart) {
      ticks.push(t)
    }
  }
  const tone = batteryTone(latest?.percent ?? 0)

  return (
    <svg
      width={chartWidth}
      height={chartHeight}
      viewBox={`0 0 ${chartWidth} ${chartHeight}`}
      className="max-w-full"
      data-testid="battery-chart"
      role="img"
      aria-label="Battery charge history and forecast"
    >
      {[0, 50, 100].map((level) => (
        <g key={level}>
          <line
            x1={chartMargin.left}
            x2={chartWidth - chartMargin.right}
            y1={y(level)}
            y2={y(level)}
            stroke="currentColor"
            strokeOpacity={level === 0 ? 0.3 : 0.12}
          />
          <text
            x={chartMargin.left - 5}
            y={y(level) + 3}
            textAnchor="end"
            fontSize="9"
            fill="currentColor"
            opacity="0.55"
          >
            {level}%
          </text>
        </g>
      ))}
      {ticks.map((t) => (
        <text key={t} x={x(t)} y={chartHeight - 5} textAnchor="middle" fontSize="9" fill="currentColor" opacity="0.55">
          {formatDate(t)}
        </text>
      ))}
      <line
        x1={x(now)}
        x2={x(now)}
        y1={chartMargin.top}
        y2={chartMargin.top + innerHeight}
        stroke="currentColor"
        strokeOpacity="0.35"
        strokeDasharray="2 3"
      />
      <text x={x(now) + 3} y={chartMargin.top + 8} fontSize="8" fill="currentColor" opacity="0.55">
        now
      </text>
      {historyPath ? (
        <path d={historyPath} fill="none" stroke={toneFill[tone]} strokeWidth="1.75" strokeLinejoin="round" />
      ) : (
        <text
          x={chartWidth / 2}
          y={chartMargin.top + innerHeight / 2}
          textAnchor="middle"
          fontSize="10"
          fill="currentColor"
          opacity="0.5"
        >
          No readings yet
        </text>
      )}
      {currentPath ? (
        <path
          d={currentPath}
          fill="none"
          stroke={toneFill[tone]}
          strokeWidth="1.5"
          strokeDasharray="4 3"
          opacity="0.8"
        />
      ) : null}
      {selectedPath ? (
        <path d={selectedPath} fill="none" stroke="#3b82f6" strokeWidth="1.5" strokeDasharray="4 3" />
      ) : null}
      {latest ? <circle cx={x(latest.t)} cy={y(latest.percent)} r="2.5" fill={toneFill[tone]} /> : null}
    </svg>
  )
}

function forecastReason(analysis: BatteryAnalysis, loading: boolean): string {
  if (loading) {
    return 'Loading the battery history…'
  }
  switch (analysis.reason) {
    case 'plugged-in':
      return 'On external power — nothing to forecast while it charges.'
    case 'no-samples':
      return 'No battery readings yet.'
    case 'no-drain':
      return 'No drain measured yet since the last charge — check back in a few hours.'
    case 'too-few-samples':
    default:
      return 'Too few readings since the last charge to forecast — check back in a few hours.'
  }
}

function BatteryForecastControls({
  analysis,
  loading,
  cycleOptions,
  observedCycle,
  selectedCycle,
  currentForecast,
  selectedForecast,
  onSelectCycle,
}: {
  analysis: BatteryAnalysis
  loading: boolean
  cycleOptions: number[]
  observedCycle: number
  selectedCycle: number
  currentForecast: BatteryForecast | null
  selectedForecast: BatteryForecast | null
  onSelectCycle: (cycle: number) => void
}): JSX.Element {
  if (!currentForecast) {
    return (
      <div className="frameos-muted text-[11px]" data-testid="battery-forecast-empty">
        {forecastReason(analysis, loading)}
      </div>
    )
  }
  const selectedIndex = Math.max(0, cycleOptions.indexOf(selectedCycle))
  const ratio = selectedForecast ? selectedForecast.hoursRemaining / Math.max(1, currentForecast.hoursRemaining) : 1
  const isCurrent = selectedCycle === observedCycle
  return (
    <div className="flex flex-col gap-2" data-testid="battery-forecast">
      <div>
        <div className="text-[11px]">
          <span className="font-semibold">At this pace: {formatRemaining(currentForecast.hoursRemaining)} left</span>
          {currentForecast.hoursRemaining < 24 * 365 ? (
            <span className="frameos-muted"> · empty around {formatDate(currentForecast.emptyAt)}</span>
          ) : null}
        </div>
        <div className="frameos-muted text-[10px]">
          {analysis.confidence === 'good'
            ? `Based on ${analysis.segment?.samples.length ?? 0} readings since the last charge.`
            : `Rough: only ${formatCycle(
                (analysis.segment ? analysis.segment.end - analysis.segment.start : 0) / 1000
              )} of readings since the last charge.`}
        </div>
      </div>
      {analysis.deepSleep ? (
        <div className="rounded-lg border border-slate-500/15 px-3 py-2">
          <label className="flex items-center justify-between gap-2 text-[11px]">
            <span>
              If it woke <span className="font-semibold">every {formatCycle(selectedCycle)}</span>
              {isCurrent ? <span className="frameos-muted"> (as now)</span> : null}
            </span>
            <span className="font-semibold tabular-nums" style={{ color: isCurrent ? undefined : '#3b82f6' }}>
              {selectedForecast ? formatRemaining(selectedForecast.hoursRemaining) : '—'}
              {!isCurrent && selectedForecast ? (
                <span className="frameos-muted font-medium">
                  {' '}
                  · ×{ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}
                </span>
              ) : null}
            </span>
          </label>
          <input
            type="range"
            min={0}
            max={cycleOptions.length - 1}
            step={1}
            value={selectedIndex}
            onChange={(event) => onSelectCycle(cycleOptions[Number(event.target.value)])}
            aria-label="Wake interval for the forecast"
            data-testid="battery-forecast-slider"
            className="mt-1.5 w-full accent-blue-500"
          />
          <div className="frameos-muted flex justify-between text-[9px]">
            <span>{formatCycle(cycleOptions[0])}</span>
            <span>{formatCycle(cycleOptions[cycleOptions.length - 1])}</span>
          </div>
          {!isCurrent && selectedForecast ? (
            <div className="frameos-muted mt-1 text-[10px]">
              {formatDrain(selectedForecast.drainPerDay)} · empty around {formatDate(selectedForecast.emptyAt)}. Set the
              render interval in Power settings to make it so.
            </div>
          ) : null}
        </div>
      ) : (
        <div className="frameos-muted text-[10px]">
          Deep sleep is off, so the frame stays awake between renders and the render interval barely changes the drain.
          Turn on deep sleep in Power settings to trade refreshes for battery life.
        </div>
      )}
    </div>
  )
}
