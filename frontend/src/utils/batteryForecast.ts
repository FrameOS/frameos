import type { FrameType, MetricsType } from '../types'
import { withoutBatteryMisreads } from './batteryMisreads'

/**
 * What a frame's battery has been doing and how long it will last.
 *
 * A battery frame (an ESP32 board with a cell on an ADC pin) wakes on a
 * timer, renders, talks to the hub — sending one metrics sample per wake —
 * and goes back to deep sleep. Almost all of the energy goes in those few
 * awake seconds: the radio, the panel refresh, the render. Deep sleep costs
 * a few hundred times less per second. So the drain per day is, to a good
 * approximation, proportional to how often the frame wakes, and the way to
 * make a battery last longer is to wake less often.
 *
 * This module reads the retained metrics history, finds the current
 * discharge (everything since the last charge), fits a drain rate to it,
 * and works out what that rate becomes at a different wake cadence:
 *
 *   rate(cycle) = k · (awake(cycle) + (1 − awake(cycle)) · SLEEP_RATIO)
 *
 * where awake(cycle) = awakeSeconds / cycle is the fraction of each cycle
 * spent awake and k is solved from the observed rate at the observed cycle.
 * SLEEP_RATIO is the deep-sleep draw relative to the awake draw — a rough
 * constant, but the sleep term is a few percent of the total at any
 * realistic cadence, so its exact value barely moves the answer.
 *
 * Pure functions, tested from cloud/apps/auth-web (frontend/ has no test
 * runner).
 */

/** Deep-sleep draw as a fraction of the awake draw (≈ 0.5-1 mA of regulators and
 * RTC against ≈ 150 mA of radio, render and panel refresh). */
export const SLEEP_RATIO = 1 / 200

/** A rise this large between neighbouring samples is a charge, not noise. */
const CHARGE_JUMP_PERCENT = 3
/** A silence this long ends a segment: the frame was off, or away. */
const SEGMENT_GAP_MS = 48 * 60 * 60 * 1000
/** Below this many samples or hours a fit says nothing useful. */
const MIN_FIT_SAMPLES = 6
const MIN_FIT_HOURS = 3
/** From here on the estimate is called good rather than rough. */
const GOOD_FIT_HOURS = 24
const GOOD_FIT_SAMPLES = 24
/** Forecasts beyond this are reported as "over a year". */
export const MAX_FORECAST_HOURS = 24 * 365
/** Awake time per wake when the samples never said (a typical ESP32 wake). */
const DEFAULT_AWAKE_SECONDS = 60

/** Wake cadences the forecast slider offers, in seconds. */
export const FORECAST_CYCLE_OPTIONS: readonly number[] = [
  60, 120, 300, 600, 900, 1200, 1800, 2700, 3600, 7200, 10800, 14400, 21600, 43200, 86400,
]

export interface BatterySample {
  /** Epoch ms. */
  t: number
  percent: number
  millivolts: number | null
  /** null when the sample did not say. */
  onBattery: boolean | null
  uptimeSeconds: number | null
  renders: number | null
  wakeCause: string | null
}

export interface DischargeSegment {
  start: number
  end: number
  samples: BatterySample[]
  startPercent: number
  endPercent: number
  /** Fitted drain, percentage points per hour; positive means discharging. */
  slopePerHour: number
}

export interface BatteryCadence {
  /** Seconds between wakes, from the sample spacing. */
  cycleSeconds: number | null
  /** Seconds awake per wake, from the samples' uptime. */
  awakeSeconds: number | null
}

export interface BatteryForecast {
  cycleSeconds: number
  /** Percentage points per day at this cadence. */
  drainPerDay: number
  hoursRemaining: number
  /** Epoch ms when the cell reaches 0% at this cadence. */
  emptyAt: number
}

export type BatteryConfidence = 'none' | 'rough' | 'good'

export interface BatteryAnalysis {
  latest: BatterySample | null
  /** Every usable sample, oldest first (misreads removed). */
  samples: BatterySample[]
  misreadCount: number
  /** The discharge the frame is in now: since its last charge. */
  segment: DischargeSegment | null
  cadence: BatteryCadence
  /** Whether the frame deep-sleeps between wakes (the cadence model applies). */
  deepSleep: boolean
  /** Observed drain on the current segment, points per day; null without a fit. */
  drainPerDay: number | null
  confidence: BatteryConfidence
  /** Why there is no forecast, for the UI. */
  reason: 'no-samples' | 'plugged-in' | 'too-few-samples' | 'no-drain' | null
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function metricTime(metric: MetricsType): number {
  return Date.parse(metric.timestamp)
}

/** The battery-relevant view of each metrics sample, misreads dropped, oldest first. */
export function batterySamplesFromMetrics(metrics: MetricsType[]): { samples: BatterySample[]; misreadCount: number } {
  const sorted = [...metrics]
    .filter((metric) => Number.isFinite(metricTime(metric)))
    .sort((a, b) => metricTime(a) - metricTime(b))
  const { metrics: checked, misreadCount } = withoutBatteryMisreads(sorted)
  const samples: BatterySample[] = []
  for (const metric of checked) {
    const percent = finiteOrNull(metric.metrics?.batteryPercent)
    if (percent === null) {
      continue
    }
    const onBattery = metric.metrics?.onBattery
    samples.push({
      t: metricTime(metric),
      percent: Math.max(0, Math.min(100, percent)),
      millivolts: finiteOrNull(metric.metrics?.batteryMillivolts),
      onBattery: typeof onBattery === 'boolean' ? onBattery : null,
      uptimeSeconds: finiteOrNull(metric.metrics?.uptimeSeconds),
      renders: finiteOrNull(metric.metrics?.renders),
      wakeCause: typeof metric.metrics?.wakeCause === 'string' ? metric.metrics.wakeCause : null,
    })
  }
  return { samples, misreadCount }
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null
  }
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** Least-squares slope of percent over hours; positive = discharging. */
function fittedDrainPerHour(samples: BatterySample[]): number {
  if (samples.length < 2) {
    return 0
  }
  const t0 = samples[0].t
  let sumX = 0
  let sumY = 0
  for (const sample of samples) {
    sumX += (sample.t - t0) / 3_600_000
    sumY += sample.percent
  }
  const meanX = sumX / samples.length
  const meanY = sumY / samples.length
  let covariance = 0
  let variance = 0
  for (const sample of samples) {
    const dx = (sample.t - t0) / 3_600_000 - meanX
    covariance += dx * (sample.percent - meanY)
    variance += dx * dx
  }
  return variance === 0 ? 0 : -covariance / variance
}

function segmentFrom(samples: BatterySample[]): DischargeSegment {
  return {
    start: samples[0].t,
    end: samples[samples.length - 1].t,
    samples,
    startPercent: samples[0].percent,
    endPercent: samples[samples.length - 1].percent,
    slopePerHour: fittedDrainPerHour(samples),
  }
}

/**
 * The runs of on-battery discharge in the samples. A run ends at a sample
 * taken on external power, at a charge (a jump up too large for noise), or
 * after a long silence. Samples on external power belong to no segment.
 */
export function dischargeSegments(samples: BatterySample[]): DischargeSegment[] {
  const segments: DischargeSegment[] = []
  let current: BatterySample[] = []
  const flush = (): void => {
    if (current.length > 0) {
      segments.push(segmentFrom(current))
    }
    current = []
  }
  for (const sample of samples) {
    if (sample.onBattery === false) {
      flush()
      continue
    }
    const previous = current[current.length - 1]
    if (
      previous &&
      (sample.percent - previous.percent > CHARGE_JUMP_PERCENT || sample.t - previous.t > SEGMENT_GAP_MS)
    ) {
      flush()
    }
    current.push(sample)
  }
  flush()
  return segments
}

/** How often the frame wakes and for how long, read off the samples. */
export function batteryCadence(samples: BatterySample[]): BatteryCadence {
  const gaps: number[] = []
  for (let i = 1; i < samples.length; i++) {
    const gap = (samples[i].t - samples[i - 1].t) / 1000
    if (gap > 0 && gap < SEGMENT_GAP_MS / 1000) {
      gaps.push(gap)
    }
  }
  const uptimes = samples
    .map((sample) => sample.uptimeSeconds)
    .filter((value): value is number => value !== null && value > 0)
  return { cycleSeconds: median(gaps), awakeSeconds: median(uptimes) }
}

/** Whether the frame's settings put it to sleep between wakes. */
export function frameDeepSleeps(
  frame: Pick<FrameType, 'deep_sleep' | 'deep_sleep_on_battery'>,
  onBattery: boolean | null
): boolean {
  if (frame.deep_sleep === true) {
    return true
  }
  return frame.deep_sleep_on_battery === true && onBattery !== false
}

/**
 * The drain per hour the model predicts at `cycleSeconds`, given the rate
 * observed at `observedCycleSeconds` with `awakeSeconds` awake per wake.
 * Without deep sleep the frame is awake all the time and the cadence
 * changes nothing.
 */
export function scaledDrainPerHour(
  observedDrainPerHour: number,
  observedCycleSeconds: number,
  awakeSeconds: number,
  cycleSeconds: number,
  deepSleep: boolean
): number {
  if (!deepSleep || observedCycleSeconds <= 0 || cycleSeconds <= 0) {
    return observedDrainPerHour
  }
  const awake = Math.min(1, awakeSeconds / observedCycleSeconds)
  const k = observedDrainPerHour / (awake + (1 - awake) * SLEEP_RATIO)
  const nextAwake = Math.min(1, awakeSeconds / cycleSeconds)
  return k * (nextAwake + (1 - nextAwake) * SLEEP_RATIO)
}

/** The forecast at a wake cadence, or null when the analysis has no fit. */
export function batteryForecast(analysis: BatteryAnalysis, cycleSeconds: number, now: number): BatteryForecast | null {
  const { latest, segment, cadence, drainPerDay, deepSleep } = analysis
  if (!latest || !segment || drainPerDay === null || drainPerDay <= 0) {
    return null
  }
  const observedCycle = cadence.cycleSeconds ?? cycleSeconds
  const awakeSeconds = cadence.awakeSeconds ?? DEFAULT_AWAKE_SECONDS
  const drainPerHour = scaledDrainPerHour(drainPerDay / 24, observedCycle, awakeSeconds, cycleSeconds, deepSleep)
  if (drainPerHour <= 0) {
    return null
  }
  // Drain since the last reading counts too: a frame read at 87% an hour
  // ago has already spent an hour of it.
  const elapsedHours = Math.max(0, (now - latest.t) / 3_600_000)
  const hoursRemaining = Math.max(0, latest.percent / drainPerHour - elapsedHours)
  return {
    cycleSeconds,
    drainPerDay: drainPerHour * 24,
    hoursRemaining,
    emptyAt: now + hoursRemaining * 3_600_000,
  }
}

/** Everything the battery popup shows, from the metrics history and the frame's settings. */
export function analyzeBattery(
  metrics: MetricsType[],
  frame: Pick<FrameType, 'deep_sleep' | 'deep_sleep_on_battery'>
): BatteryAnalysis {
  const { samples, misreadCount } = batterySamplesFromMetrics(metrics)
  const latest = samples.length > 0 ? samples[samples.length - 1] : null
  const cadence = batteryCadence(samples)
  const deepSleep = frameDeepSleeps(frame, latest?.onBattery ?? null)
  const base: BatteryAnalysis = {
    latest,
    samples,
    misreadCount,
    segment: null,
    cadence,
    deepSleep,
    drainPerDay: null,
    confidence: 'none',
    reason: null,
  }
  if (!latest) {
    return { ...base, reason: 'no-samples' }
  }
  if (latest.onBattery === false) {
    return { ...base, reason: 'plugged-in' }
  }
  const segments = dischargeSegments(samples)
  const segment = segments[segments.length - 1]
  if (!segment || segment.samples[segment.samples.length - 1] !== latest) {
    return { ...base, reason: 'too-few-samples' }
  }
  const hours = (segment.end - segment.start) / 3_600_000
  if (segment.samples.length < MIN_FIT_SAMPLES || hours < MIN_FIT_HOURS) {
    return { ...base, segment, reason: 'too-few-samples' }
  }
  const drainPerDay = segment.slopePerHour * 24
  if (drainPerDay <= 0) {
    return { ...base, segment, reason: 'no-drain' }
  }
  const good = hours >= GOOD_FIT_HOURS && segment.samples.length >= GOOD_FIT_SAMPLES
  return { ...base, segment, drainPerDay, confidence: good ? 'good' : 'rough' }
}

/** The slider's cadence steps, with the observed one spliced in so "now" is a stop. */
export function forecastCycleOptions(observedCycleSeconds: number | null): number[] {
  const options = new Set(FORECAST_CYCLE_OPTIONS)
  if (observedCycleSeconds !== null && observedCycleSeconds >= 30) {
    options.add(Math.round(observedCycleSeconds / 30) * 30)
  }
  return [...options].sort((a, b) => a - b)
}

/** The option nearest to a cadence (the slider's starting stop). */
export function nearestCycleOption(options: number[], cycleSeconds: number | null): number {
  if (options.length === 0) {
    return 900
  }
  if (cycleSeconds === null) {
    return options.includes(900) ? 900 : options[0]
  }
  let best = options[0]
  for (const option of options) {
    if (Math.abs(Math.log(option / cycleSeconds)) < Math.abs(Math.log(best / cycleSeconds))) {
      best = option
    }
  }
  return best
}

/** "15 min", "1 h 30 min", "2 days". */
export function formatCycle(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  if (minutes < 1) {
    return `${Math.round(seconds)} s`
  }
  if (minutes < 60) {
    return `${minutes} min`
  }
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours < 24) {
    return rest ? `${hours} h ${rest} min` : `${hours} h`
  }
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours ? `${days} d ${restHours} h` : `${days} day${days === 1 ? '' : 's'}`
}

/** "about 18 days", "about 5 hours", "over a year". */
export function formatRemaining(hours: number): string {
  if (hours >= MAX_FORECAST_HOURS) {
    return 'over a year'
  }
  if (hours < 1) {
    return 'under an hour'
  }
  if (hours < 48) {
    const rounded = Math.round(hours)
    return `about ${rounded} hour${rounded === 1 ? '' : 's'}`
  }
  const days = hours / 24
  if (days < 14) {
    const rounded = Math.round(days * 2) / 2
    return `about ${rounded} days`
  }
  if (days < 90) {
    return `about ${Math.round(days)} days`
  }
  const months = Math.round(days / 30)
  return `about ${months} month${months === 1 ? '' : 's'}`
}
