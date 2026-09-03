// What every browser flash flow shares: the esptool loader wrapper, the USB
// log terminal esptool writes into, the transport trace ring buffer, the
// post-flash "wait for the board to answer" loop and scene upload, and the
// USB connect button. The flows themselves are EmbeddedReleaseFlasher (a
// blank board: the published release image + provisioning over the cable)
// and EmbeddedUsbFirmwareUpdate (an enrolled board: the same release bytes
// written around its settings partition). The self-hosted backend builds no
// firmware — like the cloud, it only ever flashes signed release images.
import { CommandLineIcon, StopCircleIcon } from '@heroicons/react/24/outline'
import { useActions, useValues } from 'kea'
import type { IEspLoaderTerminal, Transport as EspTransport } from 'esptool-js'

import { Spinner } from '../../components/Spinner'
import {
  appendEmbeddedUsbLogLine,
  embeddedUsbLogsModel,
  isEmbeddedUsbLogStreamOpen,
  resolveLiveSerialPort,
  runEmbeddedUsbApiCommand,
  serialPortReconnectRequiresReselection,
  startEmbeddedUsbLogStream,
  summarizeUsbStatusJson,
} from '../../models/embeddedUsbLogsModel'
import { embeddedUsbUploadTimeoutMs } from '../../models/framesModel'
import type { FrameType, FrameId } from '../../types'
import { loadEsptool } from './esptoolLoader'
import { workspaceLogic } from './workspaceLogic'

export { watchdogResetAfterFlash } from './esp32WatchdogReset'

export type FlashPhase = 'idle' | 'connecting' | 'preparing' | 'flashing' | 'done' | 'error'
export type FlashLogTerminal = IEspLoaderTerminal & { flush: () => void }
type TraceableTransportInternals = { trace: (message: string) => void; lastTraceTime?: number }

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
