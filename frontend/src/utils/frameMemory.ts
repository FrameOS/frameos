// Internal-RAM headroom on embedded (ESP32) frames, as the device reports it.
//
// Why this exists: an ESP32 has two pools. PSRAM is large (8 MB on an S3) and
// holds the render canvas and the scene payload; INTERNAL RAM is ~300 KB and
// is what Wi-Fi, lwIP and TLS allocate from. ESP-IDF is built with
// CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL=16384, so every allocation under 16 KB —
// which is nearly all of them: parsed scene graphs, strings, the QuickJS
// context — comes out of that small pool. Add enough scenes and the frame
// still renders happily while having too little internal RAM left to open a
// TLS connection, so the cloud link fails with what looks like a network
// error. This module turns the numbers the device already reports into that
// explanation, before someone spends an evening blaming DNS.
//
// Thresholds mirror the firmware exactly: FOS_CLOUD_WS_MIN_INTERNAL_FREE and
// FOS_CLOUD_WS_MIN_INTERNAL_BLOCK in embedded/esp32/main/fos_cloud.c, which
// are themselves the log uploader's TLS thresholds
// (FOS_NIM_LOG_MIN_INTERNAL_FREE_TLS in frameos_nim_glue.c). Keep them in
// sync; the firmware is authoritative.
export const cloudLinkInternalFreeKb = 48
export const cloudLinkInternalBlockKb = 16

/** Headroom above the floor below which we warn before anything breaks. */
const comfortableMarginKb = 32

export interface FrameMemoryReport {
  /** Free internal RAM, KB (metrics `freeHeapKB`). */
  freeInternalKb: number
  /** Largest contiguous internal block, KB — TLS needs one, not just a total. */
  largestInternalBlockKb?: number
  freePsramKb?: number
  loadedScenes?: number
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Read the memory figures out of a metrics sample (the device's `metrics`
 * event, stored as the frame's last_metrics). Returns null when the sample
 * carries no internal-heap figure at all — every other field is optional
 * because older firmware did not report the largest-block number.
 */
export function readFrameMemory(metrics: unknown): FrameMemoryReport | null {
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) {
    return null
  }
  const sample = metrics as Record<string, unknown>
  const freeInternalKb = numberOrUndefined(sample.freeHeapKB)
  if (freeInternalKb === undefined) {
    return null
  }
  const report: FrameMemoryReport = { freeInternalKb }
  const block = numberOrUndefined(sample.largestHeapBlockKB)
  if (block !== undefined) report.largestInternalBlockKb = block
  const psram = numberOrUndefined(sample.freePsramKB)
  if (psram !== undefined) report.freePsramKb = psram
  const scenes = numberOrUndefined(sample.loadedScenes)
  if (scenes !== undefined) report.loadedScenes = scenes
  return report
}

export interface FrameMemoryAdvisory {
  level: 'critical' | 'warning'
  /** One-line summary for a badge or tooltip. */
  headline: string
  /** What the numbers are, and what needs them. */
  detail: string
  report: FrameMemoryReport
}

/**
 * Turn a memory report into advice, or null when the frame has room.
 *
 * `critical` means the cloud link cannot currently open a TLS session — the
 * frame renders but is unreachable. `warning` means it still fits but is
 * close enough that another scene may push it over.
 *
 * Deliberately no invented per-scene constant: scene cost ranges from a
 * kilobyte to tens of them depending on node count and inline JS, so the
 * device measures it instead (the `scenes:memory` log line from
 * fos_scenes.c). Where a measurement is not to hand, the advice stays
 * qualitative rather than making up a number.
 */
export function frameMemoryAdvisory(
  metrics: unknown,
  options: { cloudManaged?: boolean } = {}
): FrameMemoryAdvisory | null {
  const report = readFrameMemory(metrics)
  if (!report) {
    return null
  }
  const { freeInternalKb, largestInternalBlockKb } = report
  const blockTooSmall =
    largestInternalBlockKb !== undefined && largestInternalBlockKb < cloudLinkInternalBlockKb
  const critical = freeInternalKb < cloudLinkInternalFreeKb || blockTooSmall
  const warning = !critical && freeInternalKb < cloudLinkInternalFreeKb + comfortableMarginKb
  if (!critical && !warning) {
    return null
  }

  const sceneCount = report.loadedScenes
  const scenePart =
    sceneCount !== undefined ? ` with ${sceneCount} scene${sceneCount === 1 ? '' : 's'} loaded` : ''
  const psramPart =
    report.freePsramKb !== undefined
      ? ` PSRAM is not the constraint (${Math.round(report.freePsramKb)} KB free) — it is the small internal pool that TLS, Wi-Fi and lwIP draw from.`
      : ''
  const blockPart =
    largestInternalBlockKb !== undefined
      ? `, largest block ${Math.round(largestInternalBlockKb)} KB (needs ${cloudLinkInternalBlockKb} KB)`
      : ''

  if (critical) {
    return {
      detail:
        `This frame last reported ${Math.round(freeInternalKb)} KB of free internal RAM${blockPart}` +
        `${scenePart}. Opening the ${options.cloudManaged ? 'cloud link' : 'device TLS connection'} needs about ` +
        `${cloudLinkInternalFreeKb} KB free with a ${cloudLinkInternalBlockKb} KB contiguous block, so it cannot ` +
        `connect and will keep retrying.${psramPart} Remove scenes from this frame — or simplify the heaviest ones — ` +
        `and it recovers on its own without a reboot.`,
      headline: `Low memory: ${Math.round(freeInternalKb)} KB internal RAM free — too little for the cloud link`,
      level: 'critical',
      report,
    }
  }
  return {
    detail:
      `This frame last reported ${Math.round(freeInternalKb)} KB of free internal RAM${blockPart}${scenePart}. ` +
      `The cloud link needs about ${cloudLinkInternalFreeKb} KB free with a ${cloudLinkInternalBlockKb} KB block ` +
      `to open its TLS session, so there is not much headroom left.${psramPart} Adding more scenes may take the ` +
      `frame offline while leaving it rendering.`,
    headline: `Memory is tight: ${Math.round(freeInternalKb)} KB internal RAM free`,
    level: 'warning',
    report,
  }
}
