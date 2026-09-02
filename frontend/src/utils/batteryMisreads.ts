import type { MetricsType } from '../types'

/**
 * Throwing away the battery readings a frame's ADC got wrong.
 *
 * An ESP32 frame reads its cell through a resistor divider on an ADC pin
 * (embedded/esp32/main/fos_battery.c). Every way that read can go wrong —
 * a divider that has not finished charging, a supply sagging under the
 * radio, a second task switching the divider off mid-sample — pulls the
 * number DOWN, and none of them can push it up. So a lone reading far
 * below its neighbours is a misread, not a discharge: E1002 sits at
 * ~3980 mV all day and drops a 1580 mV sample every ten or twenty
 * samples, which the Li-ion curve then reports as a red 0%.
 *
 * The device-side fix (fos_battery_filter.h) samples in rounds and keeps
 * the highest, but a frame only gets it when it takes a firmware update,
 * and no amount of on-device filtering is a promise. So the cloud refuses
 * to believe a reading its neighbours contradict.
 *
 * The test is a one-sided Hampel filter — the standard way to pull spikes
 * out of a sensor series: compare each reading to the median of the
 * readings around it, and reject it when it sits further below that median
 * than the series' own noise (a median absolute deviation) explains. Only
 * the low side is rejected, because only the low side can be wrong.
 * Medians, not means: a mean is dragged by the very samples this is
 * throwing out.
 */

/** Readings on each side of the one being judged. */
const NEIGHBOURS = 4
/** Fewer neighbours than this and there is nothing to argue with. */
const MIN_NEIGHBOURS = 3
/** median absolute deviation → standard-deviation-equivalent, for normal noise. */
const MAD_SCALE = 1.4826
const MAD_MULTIPLIER = 4
/**
 * Floors, for the usual case of a series so steady its MAD is zero: a
 * settled cell reads within a few mV of itself for hours, and rejecting
 * everything outside that would drop honest samples. 200 mV is far wider
 * than ADC noise or the sag of a panel refresh, and far narrower than the
 * 600-2400 mV a real misread lands below the truth. The percent floor is
 * the same distance read off the discharge curve (~10 mV per point).
 */
const MILLIVOLT_FLOOR = 200
const PERCENT_FLOOR = 20

/** The battery keys a single bad ADC sample poisons together. */
const BATTERY_KEYS = ['batteryPercent', 'batteryMillivolts', 'onBattery'] as const

export interface BatteryCheckedMetrics {
  /** The samples, with the battery keys stripped from every misread. */
  metrics: MetricsType[]
  /** How many samples lost their battery reading. */
  misreadCount: number
}

function median(sorted: number[]): number {
  const middle = sorted.length >> 1
  const upper = sorted[middle] ?? 0
  const lower = sorted[middle - 1] ?? upper
  return sorted.length % 2 === 1 ? upper : (lower + upper) / 2
}

function medianOf(values: number[]): number {
  return median([...values].sort((a, b) => a - b))
}

/**
 * For each value, whether it sits implausibly far below its neighbours.
 * `null` marks a sample that carries no reading; it is never flagged and
 * never counts as a neighbour. Exported for the tests.
 */
export function batteryMisreadFlags(values: (number | null)[], floor: number): boolean[] {
  return values.map((value, index) => {
    if (value === null) {
      return false
    }
    const neighbours: number[] = []
    for (let i = Math.max(0, index - NEIGHBOURS); i <= Math.min(values.length - 1, index + NEIGHBOURS); i++) {
      const neighbour = values[i]
      if (i !== index && neighbour !== null && neighbour !== undefined) {
        neighbours.push(neighbour)
      }
    }
    if (neighbours.length < MIN_NEIGHBOURS) {
      return false
    }
    const reference = medianOf(neighbours)
    const mad = medianOf(neighbours.map((neighbour) => Math.abs(neighbour - reference)))
    return reference - value > Math.max(floor, MAD_MULTIPLIER * MAD_SCALE * mad)
  })
}

function finiteOrNull(value: unknown): number | null {
  const number = Number(value)
  return typeof value === 'number' && Number.isFinite(number) ? number : null
}

/**
 * The samples with every battery reading its neighbours contradict removed,
 * so that everything downstream — the charts, the header chips, the sidebar
 * glyph, "last seen on battery" — reads one number and reads it right.
 *
 * `metrics` must be in time order. Both battery series come off the same ADC
 * sample, so a verdict from either condemns the sample: they are dropped
 * together and so is `onBattery`, which the firmware derives from the same
 * voltage (a 1668 mV misread reads as "no cell present"). `batteryRawMillivolts`
 * is left alone — reporting what the raw ADC said, misreads included, is the
 * whole point of that series.
 */
export function withoutBatteryMisreads(metrics: MetricsType[]): BatteryCheckedMetrics {
  const millivolts = metrics.map((metric) => finiteOrNull(metric.metrics?.batteryMillivolts))
  const percents = metrics.map((metric) => finiteOrNull(metric.metrics?.batteryPercent))
  if (!millivolts.some((value) => value !== null) && !percents.some((value) => value !== null)) {
    return { metrics, misreadCount: 0 }
  }

  const millivoltFlags = batteryMisreadFlags(millivolts, MILLIVOLT_FLOOR)
  const percentFlags = batteryMisreadFlags(percents, PERCENT_FLOOR)
  let misreadCount = 0
  const checked = metrics.map((metric, index) => {
    if (!millivoltFlags[index] && !percentFlags[index]) {
      return metric
    }
    misreadCount++
    const cleaned = { ...metric.metrics }
    for (const key of BATTERY_KEYS) {
      delete cleaned[key]
    }
    return { ...metric, metrics: cleaned }
  })
  return { metrics: misreadCount === 0 ? metrics : checked, misreadCount }
}
