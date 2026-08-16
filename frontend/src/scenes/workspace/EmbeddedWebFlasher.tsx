import { useEffect, useState } from 'react'
import { BoltIcon, CommandLineIcon, StopCircleIcon } from '@heroicons/react/24/outline'
import { useActions, useValues } from 'kea'
import type { IEspLoaderTerminal, Transport as EspTransport } from 'esptool-js'

import { Spinner } from '../../components/Spinner'
import {
  appendEmbeddedUsbLogLine,
  embeddedUsbLogStreamSessionPort,
  embeddedUsbLogsModel,
  isEmbeddedUsbLogStreamOpen,
  prepareSerialPortReconnect,
  resolveLiveSerialPort,
  runEmbeddedUsbApiCommand,
  serialPortReconnectRequiresReselection,
  startEmbeddedUsbLogStream,
  stopEmbeddedUsbLogStream,
  summarizeUsbStatusJson,
} from '../../models/embeddedUsbLogsModel'
import { embeddedUsbUploadTimeoutMs, framesModel, scheduleEmbeddedUsbFrameImageRefresh } from '../../models/framesModel'
import type { FrameType, FrameId } from '../../types'
import { apiFetch } from '../../utils/apiFetch'
import { webSerialSupported as isWebSerialSupported, webSerialUnavailableReason } from '../../utils/webSerial'
import {
  ESP32_PARTITION_TABLE_OFFSET,
  ESP32_PARTITION_TABLE_SIZE,
  deviceLayoutMatchesPlan,
  firmwareUpdateWritePlan,
  parseEsp32PartitionTable,
} from './embeddedFlashImage'
import { watchdogResetAfterFlash } from './esp32WatchdogReset'
import { loadEsptool } from './esptoolLoader'
import { workspaceLogic } from './workspaceLogic'
import { isEsp32CloudFrame } from './workspaceSurfaces'

export { watchdogResetAfterFlash } from './esp32WatchdogReset'

export type FlashPhase = 'idle' | 'connecting' | 'preparing' | 'flashing' | 'done' | 'error'
type EspFlashSize = '4MB' | '8MB' | '16MB' | '32MB'
export type FlashLogTerminal = IEspLoaderTerminal & { flush: () => void }
type TraceableTransportInternals = { trace: (message: string) => void; lastTraceTime?: number }

const FIRMWARE_POLL_INTERVAL_MS = 3000
// How long the build may go without the status payload moving at all before
// it counts as hung. NOT a budget for the build: a first ESP-IDF build of a
// chip target compiles ~1100 objects, which is half an hour on a NUC and well
// over an hour on a Home Assistant box — a fixed deadline (this was 10
// minutes) reported "Timed out waiting for the firmware build" on builds that
// were running perfectly well, and the next flash then had to start over.
// The worker republishes lastHeartbeatAt (and its ninja edge count) every 15
// seconds while it compiles, and the backend itself marks a build failed once
// that stops for EMBEDDED_FIRMWARE_INACTIVE_AFTER_SECONDS (15 minutes), so a
// slightly longer stall window here only ever catches a backend that has
// stopped answering at all.
const FIRMWARE_STALL_TIMEOUT_MS = 16 * 60 * 1000
const FIRMWARE_PROGRESS_REPORT_INTERVAL_MS = 60 * 1000
export const POST_FLASH_BOOT_WAIT_MS = 7000
// First boot after an erase-all flash formats the 24MB SPIFFS state
// partition before the console starts — measured ~180s on a XIAO ESP32-S3
// with 32MB flash. Wait well past that.
const POST_FLASH_USB_READY_TIMEOUT_MS = 360000
const POST_FLASH_USB_READY_COMMAND_TIMEOUT_MS = 8000
const POST_FLASH_USB_READY_POLL_MS = 2500
const POST_FLASH_USB_RESET_HINT_MS = 240000
const POST_FLASH_SCENE_UPLOAD_ATTEMPTS = 3
const POST_FLASH_SCENE_UPLOAD_RETRY_MS = 3000
const ESP_FLASH_SIZES = new Set<EspFlashSize>(['4MB', '8MB', '16MB', '32MB'])

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export const STALE_BUNDLE_FLASH_ERROR =
  'Could not load the flasher: FrameOS has been updated since this page was opened. Reload the page and flash again.'

/**
 * esptool-js is fetched the first time someone flashes, which is often long
 * after the page loaded — and if FrameOS was upgraded in between, that hashed
 * chunk no longer exists on the server. The browser reports it as "Failed to
 * fetch dynamically imported module", which names neither the cause nor the
 * fix, so say both. Nothing else in this flow imports on demand, so a failure
 * here can only be the chunk.
 */
export async function loadEsptoolForFlash(): Promise<Awaited<ReturnType<typeof loadEsptool>>> {
  try {
    return await loadEsptool()
  } catch (error) {
    // Keep the browser's own wording out of the UI but not out of reach: if
    // this ever fires for some other reason, the console still says what.
    console.error('Failed to load esptool-js:', error)
    throw new Error(STALE_BUNDLE_FLASH_ERROR)
  }
}

// (watchdogResetAfterFlash — the post-flash RTC watchdog reset — lives in
// esp32WatchdogReset.ts, shared with the cloud enrollment flasher, and is
// re-exported above for its existing importers.)

type FirmwareStatus = NonNullable<NonNullable<FrameType['embedded']>['firmware']>

export function appendBrowserFlashLog(frameId: FrameId, message: string): void {
  appendEmbeddedUsbLogLine(frameId, `[browser flash] ${message}`)
}

function isFlashDataDumpLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) {
    return false
  }
  if (/(?:^|\s)[0-9a-f]{8,16}\s+[0-9a-f]{8,16}\s+\|/i.test(trimmed)) {
    return true
  }

  const compact = trimmed.replace(/\s+/g, '')
  const hexChars = compact.match(/[0-9a-f]/gi)?.length ?? 0
  return trimmed.length > 160 && trimmed.includes('|') && hexChars / compact.length > 0.65
}

function flashTraceLogMessage(message: string): string | null {
  const commandDataMatch = message.match(/^(command\s+op:0x[0-9a-f]+\s+data\s+len=(\d+)\b.*?)(?:\s+data=|$)/i)
  if (commandDataMatch) {
    return `${commandDataMatch[1]} (raw data hidden)`
  }

  const readWriteMatch = message.match(/^(Read|Write)\s+(\d+)\s+bytes:/i)
  if (readWriteMatch) {
    return `${readWriteMatch[1]} ${readWriteMatch[2]} bytes (raw data hidden)`
  }

  if (/^Received full packet:/i.test(message)) {
    return 'Received full packet (raw data hidden)'
  }

  if (isFlashDataDumpLine(message)) {
    return null
  }

  return message
}

export function createUsbLogTerminal(frameId: FrameId): FlashLogTerminal {
  let pendingLine = ''
  let flushTimer: ReturnType<typeof window.setTimeout> | null = null

  const clearFlushTimer = (): void => {
    if (flushTimer !== null) {
      window.clearTimeout(flushTimer)
      flushTimer = null
    }
  }

  const flush = (): void => {
    clearFlushTimer()
    if (!pendingLine) {
      return
    }
    if (!isFlashDataDumpLine(pendingLine)) {
      appendEmbeddedUsbLogLine(frameId, pendingLine)
    }
    pendingLine = ''
  }

  const scheduleFlush = (): void => {
    clearFlushTimer()
    flushTimer = window.setTimeout(flush, 500)
  }

  const writeText = (text: string): void => {
    pendingLine += text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const lines = pendingLine.split('\n')
    pendingLine = lines.pop() ?? ''
    for (const line of lines) {
      if (!isFlashDataDumpLine(line)) {
        appendEmbeddedUsbLogLine(frameId, line)
      }
    }
    if (pendingLine) {
      scheduleFlush()
    }
  }

  return {
    clean: () => {},
    flush,
    write: (data: string) => writeText(data),
    writeLine: (data: string) => writeText(`${data}\n`),
  }
}

// esptool's transport chatter ("command op:0x09 data len=16", "Read 12
// bytes") is the only record of what the protocol did, and the only thing
// worth having when a flash fails — but it is meaningless to someone
// watching a working flash. Keep it in a ring buffer and put it in the log
// only if the flash actually fails.
const FLASH_TRACE_BUFFERED_LINES = 500

export interface FlashTraceRecorder {
  /** The write finished: the next port loss is the reboot, not a fault. */
  expectReboot: () => void
  /** Replay the buffered protocol trace so a failed flash stays diagnosable. */
  dumpAfterFailure: () => void
}

export function recordTransportTrace(frameId: FrameId, transport: EspTransport): FlashTraceRecorder {
  const traceableTransport = transport as unknown as TraceableTransportInternals
  const originalTrace = traceableTransport.trace.bind(traceableTransport)
  const buffered: string[] = []
  let rebootExpected = false

  traceableTransport.trace = (message: string): void => {
    const delta = Date.now() - (traceableTransport.lastTraceTime ?? Date.now())
    const logMessage = flashTraceLogMessage(message)
    if (logMessage) {
      buffered.push(`TRACE ${delta.toFixed(3)} ${logMessage}`)
      if (buffered.length > FLASH_TRACE_BUFFERED_LINES) {
        buffered.shift()
      }
    }
    // esptool reports the post-write reboot as "Unrecoverable serial port
    // error: The device has been lost." — a catastrophe only if it happens
    // before the image is written, and then the flash fails and says so.
    if (rebootExpected && /device has been lost|unrecoverable serial port error/i.test(message)) {
      rebootExpected = false
      appendBrowserFlashLog(frameId, 'The board dropped off USB — it is rebooting into the new firmware.')
    }
    originalTrace(message)
  }

  return {
    expectReboot: () => {
      rebootExpected = true
    },
    dumpAfterFailure: () => {
      if (buffered.length === 0) {
        return
      }
      appendBrowserFlashLog(frameId, `Flasher protocol trace (last ${buffered.length} lines):`)
      for (const line of buffered) {
        appendEmbeddedUsbLogLine(frameId, line)
      }
      buffered.length = 0
    },
  }
}

async function fetchFirmwareStatus(frameId: FrameId): Promise<FirmwareStatus> {
  const response = await apiFetch(`/api/frames/${frameId}/embedded/firmware`)
  if (!response.ok) {
    throw new Error('Failed to fetch firmware status')
  }
  const firmware = ((await response.json())?.firmware ?? {}) as FirmwareStatus
  framesModel.actions.updateEmbeddedFirmwareStatus(frameId, firmware)
  return firmware
}

async function startFirmwareBuild(frameId: FrameId, force = false): Promise<FirmwareStatus> {
  const response = await apiFetch(`/api/frames/${frameId}/embedded/firmware${force ? '?force=1' : ''}`, {
    method: 'POST',
  })
  if (!response.ok) {
    let detail = 'Failed to start firmware build'
    try {
      detail = (await response.json())?.detail || detail
    } catch (error) {}
    throw new Error(detail)
  }
  const firmware = ((await response.json())?.firmware ?? {}) as FirmwareStatus
  framesModel.actions.updateEmbeddedFirmwareStatus(frameId, firmware)
  return firmware
}

function normalizeFlashSize(value: unknown): EspFlashSize {
  if (typeof value !== 'string') {
    return '8MB'
  }
  const normalized = value.trim().toUpperCase().replace(/\s+/g, '')
  return ESP_FLASH_SIZES.has(normalized as EspFlashSize) ? (normalized as EspFlashSize) : '8MB'
}

function firmwareFlashSize(frame: FrameType, firmware?: FirmwareStatus | null): EspFlashSize {
  return normalizeFlashSize(firmware?.flashSize ?? frame.embedded?.flashSize ?? frame.embedded?.firmware?.flashSize)
}

function buildStartMessage(status: FirmwareStatus['status']): string {
  return status === 'stale'
    ? 'Rebuilding firmware from current settings'
    : status === 'missing'
    ? 'Rebuilding missing firmware image'
    : 'Building firmware image'
}

/**
 * What the build looks like from outside: its ninja edge count when the worker
 * has published one, so the user can tell a build that is 4% done from one
 * that is stuck. `startedAt` gives the elapsed time, which is the number that
 * says whether it is worth waiting for.
 */
export function firmwareBuildProgressMessage(firmware: FirmwareStatus): string {
  if (firmware.status === 'queued') {
    return 'Waiting for a build worker'
  }
  const progress = firmware.buildProgress
  const startedAt = firmware.startedAt ? Date.parse(firmware.startedAt) : NaN
  const elapsedMinutes = Number.isNaN(startedAt) ? null : Math.floor((Date.now() - startedAt) / 60000)
  const elapsed = elapsedMinutes && elapsedMinutes > 0 ? `, ${elapsedMinutes}m elapsed` : ''
  if (!progress || !progress.total) {
    return `Building firmware image${elapsed}`
  }
  return `Building firmware image: ${Math.round(progress.percent)}% (${progress.done}/${progress.total})${elapsed}`
}

/** Whatever in the status proves the build is still moving. */
function firmwareActivityKey(firmware: FirmwareStatus): string {
  return [firmware.status, firmware.lastHeartbeatAt ?? '', firmware.buildProgress?.done ?? ''].join('|')
}

/** Make sure a fresh firmware image exists, building one if needed. */
async function ensureFirmwareReady(frameId: FrameId, onStatus: (message: string) => void): Promise<FirmwareStatus> {
  let firmware = await fetchFirmwareStatus(frameId)
  if (firmware.status !== 'ready') {
    onStatus(buildStartMessage(firmware.status))
    firmware = await startFirmwareBuild(frameId, firmware.status === 'stale' || firmware.status === 'missing')

    let recoveryAttempts = 0
    let activityKey = firmwareActivityKey(firmware)
    let stallDeadline = Date.now() + FIRMWARE_STALL_TIMEOUT_MS
    let lastReportAt = Date.now()
    while (firmware.status !== 'ready') {
      if (firmware.status === 'missing' || firmware.status === 'stale') {
        if (recoveryAttempts >= 2) {
          throw new Error(firmware.error || 'Firmware image needs to be rebuilt')
        }
        recoveryAttempts += 1
        onStatus(buildStartMessage(firmware.status))
        firmware = await startFirmwareBuild(frameId, true)
        continue
      }
      if (firmware.status === 'error') {
        throw new Error(firmware.error || 'Firmware build failed')
      }
      if (Date.now() > stallDeadline) {
        throw new Error(
          'The firmware build stopped reporting progress. Check the frame log, then start the flash again — ' +
            'a build that is still running is picked up where it left off.'
        )
      }
      await sleep(FIRMWARE_POLL_INTERVAL_MS)
      firmware = await fetchFirmwareStatus(frameId)
      const nextActivityKey = firmwareActivityKey(firmware)
      if (nextActivityKey !== activityKey) {
        activityKey = nextActivityKey
        stallDeadline = Date.now() + FIRMWARE_STALL_TIMEOUT_MS
        // Every status message is also a frame-log line, and the build
        // heartbeats every 15 seconds for anything up to an hour. Report on
        // the minute instead of writing 240 lines about the same build.
        if (Date.now() - lastReportAt >= FIRMWARE_PROGRESS_REPORT_INTERVAL_MS) {
          lastReportAt = Date.now()
          onStatus(firmwareBuildProgressMessage(firmware))
        }
      }
    }
  }
  return firmware
}

async function downloadFirmware(downloadUrl: string): Promise<Uint8Array> {
  // Firmware paths are replaced in place after rebuilds. Bypass any older
  // cached response even when talking to a backend that supplied a stable URL.
  const response = await apiFetch(downloadUrl, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error('Failed to download firmware image')
  }
  return new Uint8Array(await response.arrayBuffer())
}

export interface ServerFirmwareWritePlan {
  fileArray: { address: number; data: Uint8Array }[]
  totalBytes: number
  /** The partition being flashed around, when the device's settings are kept. */
  preserved?: { name: string; size: number }
  /** Why the plan fell back to the full write, when it did. */
  warning?: string
}

/**
 * How to write a server-built merged image: around the NVS partition when the
 * user asked to keep the device's saved settings (Wi-Fi credentials, keys,
 * panel choice), or as one monolithic write at the flash offset otherwise.
 *
 * Unlike the release updater (EmbeddedUsbFirmwareUpdate), a plan that cannot
 * be built or verified here falls back to the full write instead of aborting:
 * the server-built image carries this frame's own baked-in configuration, so
 * a full write still yields a working frame — it just resets whatever the
 * device saved on top, and the warning says so.
 */
export async function planServerFirmwareWrite(options: {
  firmware: Uint8Array
  flashOffset: number
  keepSettings: boolean
  loader: { readFlash?: (address: number, size: number) => Promise<Uint8Array> }
  log: (message: string) => void
}): Promise<ServerFirmwareWritePlan> {
  const { firmware, flashOffset, keepSettings, loader, log } = options
  const fullWrite: ServerFirmwareWritePlan = {
    fileArray: [{ address: flashOffset, data: firmware }],
    totalBytes: firmware.byteLength,
  }
  if (!keepSettings) {
    return fullWrite
  }
  if (flashOffset !== 0) {
    // The write plan's segment addresses are absolute flash offsets — the
    // shape `idf.py merge-bin` produces from 0x0. An image that flashes
    // elsewhere cannot be split around a partition table it does not carry.
    return {
      ...fullWrite,
      warning: `This image flashes at 0x${flashOffset.toString(
        16
      )}, not 0x0, so its settings partition cannot be located. Writing the whole image.`,
    }
  }
  let plan
  try {
    plan = firmwareUpdateWritePlan(firmware)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ...fullWrite,
      warning: `Cannot flash around the settings partition (${detail}). Writing the whole image instead — the board's saved settings reset to this build's values.`,
    }
  }
  if (typeof loader.readFlash === 'function') {
    let table: Uint8Array | null = null
    try {
      table = await loader.readFlash(ESP32_PARTITION_TABLE_OFFSET, ESP32_PARTITION_TABLE_SIZE)
    } catch (error) {
      log("Could not read the board's partition table; trusting the image's own layout.")
    }
    if (table) {
      const partitions = parseEsp32PartitionTable(table)
      if (partitions.length === 0) {
        // A blank or freshly erased board: nothing saved yet, nothing to lose.
        log("The board has no readable partition table yet; trusting the image's own layout.")
      } else if (!deviceLayoutMatchesPlan(partitions, plan)) {
        return {
          ...fullWrite,
          warning:
            'The board is partitioned differently from this image, so its settings partition cannot be spared. ' +
            "Writing the whole image instead — the board's saved settings reset to this build's values.",
        }
      }
    }
  }
  return {
    fileArray: plan.segments.map((segment) => ({ address: segment.address, data: segment.data })),
    totalBytes: plan.totalBytes,
    preserved: { name: plan.preserved.name, size: plan.preserved.size },
  }
}

/**
 * Why a cloud-managed frame never uploads scenes over USB.
 *
 * The USB push needs the scene BODIES — nodes, edges, app configs — which is
 * what a backend frame carries in `frame.scenes`. The cloud's frame payload
 * has no scenes field at all: assignments live on /api/frames/{id}/scenes and
 * are ids and versions, not bodies, because the hub pushes the bodies to the
 * device itself over the websocket. So there is nothing here to send, and the
 * frame gets its scenes moments later from the cloud instead.
 *
 * Worth naming because the two cases look identical from the flasher's side
 * and only one of them is a problem: an empty `frame.scenes` on a BACKEND
 * frame really does mean nothing is configured.
 */
function scenesArriveFromCloud(frame: FrameType): boolean {
  return isEsp32CloudFrame(frame)
}

/** Send the workspace's scenes to a board that has just come back on USB.
 * Retries: the board answers `status` before its scene store is settled often
 * enough that one attempt loses a first deploy. Returns false when the frame
 * has no scenes to send. */
export async function uploadScenesOverUsbAfterFlash(
  frame: FrameType,
  port: SerialPort,
  onStatus: (message: string) => void
): Promise<boolean> {
  const scenes = frame.scenes ?? []
  if (scenes.length === 0) {
    return false
  }

  const payload = new TextEncoder().encode(JSON.stringify(scenes))
  let lastError: unknown = null
  for (let attempt = 1; attempt <= POST_FLASH_SCENE_UPLOAD_ATTEMPTS; attempt += 1) {
    onStatus(
      attempt === 1
        ? `Uploading ${scenes.length} scene(s) over USB`
        : `Retrying scene upload over USB (${attempt}/${POST_FLASH_SCENE_UPLOAD_ATTEMPTS})`
    )
    try {
      await runEmbeddedUsbApiCommand(frame.id, 'upload-scenes', {
        payload,
        port,
        timeoutMs: embeddedUsbUploadTimeoutMs(payload.byteLength),
        keepOpen: true,
      })
      return true
    } catch (error) {
      lastError = error
      if (attempt < POST_FLASH_SCENE_UPLOAD_ATTEMPTS) {
        await sleep(POST_FLASH_SCENE_UPLOAD_RETRY_MS)
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Failed to upload scenes over USB')
}

function usbStatusSummary(text: string | undefined): string {
  const summary = text ? summarizeUsbStatusJson(text) : null
  return summary ? `The board answered on USB: ${summary}` : 'The board answered on USB'
}

// Returns the port the board answered on: the watchdog reset after flashing
// re-enumerates the USB device, so the original SerialPort object may have
// been replaced by a fresh grant from getPorts().
export async function waitForUsbApiReadyAfterFlash(
  frame: FrameType,
  port: SerialPort,
  onStatus: (message: string) => void,
  // The storage-format warning is specific to a flash that wiped the state
  // partition; a flow that kept it (the USB firmware update) says so instead.
  initialMessage = 'Waiting for board USB API. A brand-new or fully erased board formats its storage first (~3 minutes).'
): Promise<SerialPort> {
  const started = Date.now()
  const deadline = started + POST_FLASH_USB_READY_TIMEOUT_MS
  let attempt = 0
  let lastError: unknown = null
  let resetHintShown = false
  onStatus(initialMessage)

  while (Date.now() < deadline) {
    attempt += 1
    const livePort = await resolveLiveSerialPort(port)
    if (livePort && livePort !== port) {
      appendBrowserFlashLog(frame.id, 'USB device re-enumerated after reboot; switching to the new port.')
      port = livePort
    } else if (!livePort && serialPortReconnectRequiresReselection(port)) {
      throw new Error(
        'Multiple identical USB devices are available. Select the target board again before uploading scenes.'
      )
    }
    try {
      const result = await runEmbeddedUsbApiCommand(frame.id, 'status', {
        port,
        timeoutMs: Math.min(POST_FLASH_USB_READY_COMMAND_TIMEOUT_MS, Math.max(1000, deadline - Date.now())),
        mirrorOutput: false,
        keepOpen: true,
        probe: true,
      })
      appendBrowserFlashLog(frame.id, usbStatusSummary(result.text))
      return port
    } catch (error) {
      lastError = error
      if (attempt === 1 || attempt % 4 === 0) {
        // A board that is still booting simply does not answer; that is
        // progress, not a failure. Anything else is worth naming.
        const detail = error instanceof Error ? error.message : String(error)
        const stillBooting = /Timed out waiting for USB command (?:response|ready)/i.test(detail)
        const waited = Math.round((Date.now() - started) / 1000)
        appendBrowserFlashLog(
          frame.id,
          stillBooting
            ? `Waiting for the board to boot (attempt ${attempt}, ${waited}s)`
            : `Waiting for the board to boot (attempt ${attempt}, ${waited}s): ${detail}`
        )
      }
      if (!resetHintShown && Date.now() - started > POST_FLASH_USB_RESET_HINT_MS) {
        resetHintShown = true
        onStatus(
          'Board still not responding after the storage-format window. Try pressing its RESET button — it may be stuck in download mode.'
        )
      }
      await sleep(Math.min(POST_FLASH_USB_READY_POLL_MS, Math.max(0, deadline - Date.now())))
    }
  }

  const detail = lastError instanceof Error ? lastError.message : lastError ? String(lastError) : 'no response'
  throw new Error(`Timed out waiting for board USB API after reboot: ${detail}`)
}

function usbConnectionButtonLabel(
  usbLogStreamState: { status?: string } | undefined,
  usbLogStreamOpen: boolean
): string {
  return usbLogStreamState?.status === 'selecting'
    ? 'Select USB port'
    : usbLogStreamState?.status === 'connecting'
    ? 'Connecting USB'
    : usbLogStreamState?.status === 'stopping'
    ? 'Disconnecting USB'
    : usbLogStreamOpen
    ? 'Disconnect USB'
    : 'Connect USB'
}

export function EmbeddedUsbConnectionButton({
  frame,
  disabled = false,
  className = '',
}: {
  frame: FrameType
  disabled?: boolean
  className?: string
}): JSX.Element {
  const { openFrameToolBehindDrawer } = useActions(workspaceLogic)
  const { stopUsbLogStream } = useActions(embeddedUsbLogsModel)
  const { usbLogStreamStatesByFrameId } = useValues(embeddedUsbLogsModel)
  const usbLogStreamState = usbLogStreamStatesByFrameId[frame.id]
  const usbLogStreamOpen = isEmbeddedUsbLogStreamOpen(usbLogStreamState)
  const usbLogStreamBusy =
    usbLogStreamState?.status === 'selecting' ||
    usbLogStreamState?.status === 'connecting' ||
    usbLogStreamState?.status === 'stopping'

  const connectUsb = async (): Promise<void> => {
    const started = await startEmbeddedUsbLogStream(frame.id)
    if (started) {
      openFrameToolBehindDrawer(frame.id, 'logs')
    }
  }

  return (
    <button
      type="button"
      onClick={usbLogStreamOpen ? () => stopUsbLogStream(frame.id) : connectUsb}
      disabled={disabled || usbLogStreamBusy}
      className={`frameos-secondary-button inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40 ${className}`}
    >
      {usbLogStreamState?.status === 'selecting' || usbLogStreamState?.status === 'connecting' ? (
        <Spinner />
      ) : usbLogStreamOpen ? (
        <StopCircleIcon className="h-4 w-4" />
      ) : (
        <CommandLineIcon className="h-4 w-4" />
      )}
      {usbConnectionButtonLabel(usbLogStreamState, usbLogStreamOpen)}
    </button>
  )
}

export function EmbeddedWebFlasher({
  frame,
  disabled = false,
  onBusyChange,
}: {
  frame: FrameType
  disabled?: boolean
  onBusyChange?: (busy: boolean) => void
}): JSX.Element {
  const [phase, setPhase] = useState<FlashPhase>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [keepSettingsChecked, setKeepSettingsChecked] = useState(true)
  const { openFrameToolBehindDrawer } = useActions(workspaceLogic)
  const { usbLogStreamStatesByFrameId } = useValues(embeddedUsbLogsModel)

  const webSerialSupported = isWebSerialSupported()
  const busy = phase === 'connecting' || phase === 'preparing' || phase === 'flashing'
  const usbLogStreamState = usbLogStreamStatesByFrameId[frame.id]
  // Only offer to flash around the settings partition when the firmware status
  // reports a partition layout (with_embedded_firmware_layout on the backend);
  // without one there is no NVS to reason about — e.g. pico/virtual frames.
  const canKeepSettings = (frame.embedded?.firmware?.layout?.flash?.partitions ?? []).length > 0
  const keepSettings = canKeepSettings && keepSettingsChecked

  useEffect(() => {
    onBusyChange?.(busy)
  }, [busy, onBusyChange])

  useEffect(() => {
    return () => onBusyChange?.(false)
  }, [onBusyChange])

  const flash = async (): Promise<void> => {
    let port: SerialPort | null = null
    let transport: EspTransport | null = null
    let flashTerminal: FlashLogTerminal | null = null
    let traceRecorder: FlashTraceRecorder | null = null
    let streamLogsAfterFlash = false
    const setFlashMessage = (nextMessage: string | null): void => {
      setMessage(nextMessage)
      if (nextMessage) {
        appendBrowserFlashLog(frame.id, nextMessage)
      }
    }

    setPhase('connecting')
    setProgress(null)
    setFlashMessage('Selecting USB port')
    // Do not switch drawer views here: the firmware section renders inline
    // in the main deploy view too, and swapping views would unmount THIS
    // component instance — the flash keeps running, but its progress bar
    // and status messages update a dead instance and vanish.
    try {
      // Must run inside the click gesture, before any other await
      const activeLogPort = embeddedUsbLogStreamSessionPort(frame.id)
      port = activeLogPort ? await stopEmbeddedUsbLogStream(frame.id) : await navigator.serial.requestPort()
      if (!port) {
        setPhase('idle')
        setMessage(null)
        return
      }
      await prepareSerialPortReconnect(port)
      openFrameToolBehindDrawer(frame.id, 'logs')
      appendBrowserFlashLog(frame.id, 'USB port selected')

      // The image comes first, and the board is only put into download mode
      // once there are bytes to write. A first build of a chip target takes
      // tens of minutes; connecting first would hold the chip in the ROM
      // bootloader for all of it, with the serial port claimed and the frame
      // showing nothing.
      setPhase('preparing')
      const firmwareStatus = await ensureFirmwareReady(frame.id, setFlashMessage)
      const downloadUrl = firmwareStatus.downloadUrl || `/api/frames/${frame.id}/embedded/firmware/download`
      const flashOffset =
        parseInt(firmwareStatus.flashOffset || frame.embedded?.firmware?.flashOffset || '0x0', 16) || 0
      const flashSize = firmwareFlashSize(frame, firmwareStatus)
      setFlashMessage('Downloading firmware image')
      const firmware = await downloadFirmware(downloadUrl)

      // Loaded on demand: esptool-js adds ~380KB we only need when actually flashing
      const { ESPLoader, Transport } = await loadEsptoolForFlash()
      transport = new Transport(port, false)
      traceRecorder = recordTransportTrace(frame.id, transport)
      flashTerminal = createUsbLogTerminal(frame.id)

      setPhase('connecting')
      setFlashMessage('Connecting to the board')
      const loader = new ESPLoader({ transport, baudrate: 460800, enableTracing: true, terminal: flashTerminal })
      const chip = await loader.main()
      setFlashMessage(`Connected to ${chip}`)

      // Keep-settings: write the image in segments around its NVS partition so
      // whatever the board saved at runtime (Wi-Fi joined over the console,
      // rotated keys) survives the re-flash. Falls back to the monolithic
      // write when the plan cannot be built or the board is partitioned
      // differently — the server-built image carries this frame's own baked-in
      // defaults, so a full write still works, it just resets those settings.
      const writePlan = await planServerFirmwareWrite({
        firmware,
        flashOffset,
        keepSettings,
        loader,
        log: (line) => appendBrowserFlashLog(frame.id, line),
      })
      if (writePlan.warning) {
        setFlashMessage(writePlan.warning)
      }

      setPhase('flashing')
      setFlashMessage(
        writePlan.preserved
          ? `Flashing ${Math.round(writePlan.totalBytes / 1024)}KB to ${chip}, keeping the device's saved settings (${
              writePlan.preserved.name
            }, ${Math.round(writePlan.preserved.size / 1024)}KB untouched)`
          : `Flashing ${Math.round(writePlan.totalBytes / 1024)}KB to ${chip}`
      )
      // reportProgress counts per segment; weight them into one bar.
      const segmentOffsets = writePlan.fileArray.map((_, index) =>
        writePlan.fileArray.slice(0, index).reduce((total, segment) => total + segment.data.byteLength, 0)
      )
      await loader.writeFlash({
        fileArray: writePlan.fileArray,
        flashSize,
        flashMode: 'keep',
        flashFreq: 'keep',
        // eraseAll off: the merged image's FF padding already overwrites NVS,
        // otadata and RF calibration when they sit inside the written range
        // (and the keep-settings plan skips the NVS on purpose). The state
        // partition beyond it survives, sparing the ~3 minute SPIFFS format
        // on every re-flash — scenes are re-uploaded right after boot anyway.
        eraseAll: false,
        compress: true,
        reportProgress: (fileIndex, written, total) => {
          const done = (segmentOffsets[fileIndex] ?? 0) + (total > 0 ? written : 0)
          setProgress(writePlan.totalBytes > 0 ? Math.min(100, Math.round((done / writePlan.totalBytes) * 100)) : null)
        },
      })
      traceRecorder.expectReboot()
      // Prefer a watchdog reset: a DTR/RTS pulse can strap USB-Serial/JTAG
      // boards back into ROM download mode instead of booting the app. Fall
      // back to pulsing the reset line the way the esptool CLI does —
      // esptool-js's built-in hard reset never asserts RTS at all.
      if (!(await watchdogResetAfterFlash(loader))) {
        try {
          await transport.setDTR(false)
          await transport.setRTS(true)
          await sleep(100)
          await transport.setRTS(false)
          await transport.setDTR(false)
        } catch (error) {
          // The port disappears if the chip already reset mid-command; the
          // post-flash USB API wait re-acquires it and sorts out the rest.
        }
      }

      setPhase('preparing')
      setProgress(null)
      setFlashMessage('Firmware flashed. Waiting for the board to reboot.')
      streamLogsAfterFlash = true
    } catch (error) {
      setPhase('error')
      setProgress(null)
      const detail = error instanceof Error ? error.message : String(error)
      const displayMessage = /No port selected/i.test(detail)
        ? null
        : /Failed to open serial port/i.test(detail)
        ? 'Could not open the serial port. Close other serial monitors and try again.'
        : detail
      setMessage(displayMessage)
      if (/No port selected/i.test(detail)) {
        setPhase('idle')
      } else if (displayMessage) {
        appendBrowserFlashLog(frame.id, `Flash failed: ${displayMessage}`)
        traceRecorder?.dumpAfterFailure()
      }
    } finally {
      flashTerminal?.flush()
      if (transport) {
        try {
          await transport.disconnect()
        } catch (error) {}
      }
      if (streamLogsAfterFlash && port) {
        try {
          await sleep(POST_FLASH_BOOT_WAIT_MS)
          port = await waitForUsbApiReadyAfterFlash(frame, port, setFlashMessage)
          const scenesUploaded = await uploadScenesOverUsbAfterFlash(frame, port, setFlashMessage)
          if (scenesUploaded) {
            const completeResponse = await apiFetch(`/api/frames/${frame.id}/embedded/usb_deploy_complete`, {
              method: 'POST',
            })
            if (!completeResponse.ok) {
              throw new Error('Scene upload completed, but backend deploy state update failed')
            }
            framesModel.actions.loadFrame(frame.id)
            scheduleEmbeddedUsbFrameImageRefresh(frame.id)
            setPhase('done')
            setFlashMessage(`Firmware flashed and ${frame.scenes?.length ?? 0} scene(s) uploaded.`)
            appendBrowserFlashLog(
              frame.id,
              'The frame is rendering its first scene — e-paper refreshes take a few minutes; the preview appears when it finishes.'
            )
          } else {
            setPhase('done')
            // "No scenes configured" is false and alarming on a cloud frame,
            // which always lands here: its scenes are on their way over the
            // websocket, not missing.
            const message = scenesArriveFromCloud(frame)
              ? 'Firmware flashed. The cloud will push this frame\u2019s scenes when it reconnects.'
              : 'Firmware flashed. No scenes configured to upload.'
            setFlashMessage(message)
            appendBrowserFlashLog(frame.id, message)
          }
        } catch (error) {
          setPhase('error')
          const detail = error instanceof Error ? error.message : String(error)
          setFlashMessage(`Firmware flashed, but scene upload failed: ${detail}`)
        }

        const logStreamStarted = await startEmbeddedUsbLogStream(frame.id, port)
        openFrameToolBehindDrawer(frame.id, 'logs')
        if (!logStreamStarted) {
          appendBrowserFlashLog(frame.id, 'USB serial log stream could not be reopened after flashing.')
        }
      }
    }
  }

  if (!webSerialSupported) {
    return (
      <div className="frame-tool-muted text-xs leading-5">
        {webSerialUnavailableReason('Flashing from the browser')} Otherwise flash with the command above.
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={flash}
          disabled={disabled || busy}
          className="frameos-primary-action inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40"
        >
          {busy ? <Spinner color="white" /> : <BoltIcon className="h-4 w-4" />}
          {phase === 'flashing' && progress !== null
            ? `Flashing ${progress}%`
            : busy
            ? 'Flashing'
            : 'Flash from browser'}
        </button>
        <EmbeddedUsbConnectionButton frame={frame} disabled={disabled || busy} />
      </div>
      {canKeepSettings ? (
        <label className="frame-tool-muted flex items-center gap-2 text-xs leading-5">
          <input
            type="checkbox"
            checked={keepSettingsChecked}
            disabled={busy}
            onChange={(event) => setKeepSettingsChecked(event.target.checked)}
          />
          Keep device settings (Wi-Fi, keys) — flash around the settings partition. Untick to reset the board to this
          build's values.
        </label>
      ) : null}
      {phase === 'flashing' && progress !== null ? (
        <div className="frameos-inset h-2 w-full overflow-hidden rounded-full border">
          <div className="h-full rounded-full bg-blue-500 transition-all" style={{ width: `${progress}%` }} />
        </div>
      ) : null}
      {message ? (
        <div
          className={
            phase === 'error'
              ? 'text-xs font-semibold text-red-500'
              : phase === 'done'
              ? 'text-xs font-semibold text-green-600'
              : 'frame-tool-muted text-xs leading-5'
          }
        >
          {message}
        </div>
      ) : null}
      {usbLogStreamState?.status === 'error' && usbLogStreamState.error ? (
        <div className="text-xs font-semibold text-red-500">{usbLogStreamState.error}</div>
      ) : null}
    </div>
  )
}
