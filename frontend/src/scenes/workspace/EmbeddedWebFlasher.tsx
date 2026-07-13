import { useEffect, useState } from 'react'
import { BoltIcon, CommandLineIcon, StopCircleIcon } from '@heroicons/react/24/outline'
import { useActions, useValues } from 'kea'
import type { ESPLoader, IEspLoaderTerminal, Transport as EspTransport } from 'esptool-js'

import { Spinner } from '../../components/Spinner'
import {
  appendEmbeddedUsbLogLine,
  embeddedUsbLogStreamSessionPort,
  embeddedUsbLogsModel,
  isEmbeddedUsbLogStreamOpen,
  resolveLiveSerialPort,
  runEmbeddedUsbApiCommand,
  startEmbeddedUsbLogStream,
  stopEmbeddedUsbLogStream,
} from '../../models/embeddedUsbLogsModel'
import { embeddedUsbUploadTimeoutMs, framesModel, scheduleEmbeddedUsbFrameImageRefresh } from '../../models/framesModel'
import type { FrameType } from '../../types'
import { apiFetch } from '../../utils/apiFetch'
import { frameLogic } from '../frame/frameLogic'
import { workspaceLogic } from './workspaceLogic'

type FlashPhase = 'idle' | 'connecting' | 'preparing' | 'flashing' | 'done' | 'error'
type EspFlashSize = '4MB' | '8MB' | '16MB' | '32MB'
type FlashLogTerminal = IEspLoaderTerminal & { flush: () => void }
type TraceableTransportInternals = { trace: (message: string) => void; lastTraceTime?: number }

const FIRMWARE_POLL_INTERVAL_MS = 3000
const FIRMWARE_POLL_TIMEOUT_MS = 10 * 60 * 1000
const POST_FLASH_BOOT_WAIT_MS = 7000
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ESP32-S3 RTC_CNTL registers, values from esptool's targets/esp32s3.py
const S3_RTC_CNTL_OPTION1_REG = 0x6000812c
const S3_RTC_CNTL_FORCE_DOWNLOAD_BOOT_MASK = 0x1
const S3_RTC_CNTL_WDTCONFIG0_REG = 0x60008098
const S3_RTC_CNTL_WDTCONFIG1_REG = 0x6000809c
const S3_RTC_CNTL_WDTWPROTECT_REG = 0x600080b0
const S3_RTC_CNTL_WDT_WKEY = 0x50d83aa1
// WDT_EN | STG0=reset system | sys reset length | cpu reset length
const S3_RTC_WDT_RESET_CONFIG = (0x80000000 | (5 << 28) | (1 << 8) | 2) >>> 0

// Reset the chip via the RTC watchdog, like `esptool --after watchdog-reset`.
// A DTR/RTS reset pulse goes through the USB-Serial/JTAG strap logic, which on
// some boards (XIAO ESP32-S3) latches the chip back into ROM download mode so
// the app never boots after flashing (arduino-esp32#6762). The watchdog reset
// runs over the flasher-stub protocol and never touches the strap pins.
async function watchdogResetAfterFlash(loader: ESPLoader): Promise<boolean> {
  if (loader.chip?.CHIP_NAME !== 'ESP32-S3') {
    return false
  }
  try {
    await loader.writeReg(S3_RTC_CNTL_OPTION1_REG, 0, S3_RTC_CNTL_FORCE_DOWNLOAD_BOOT_MASK)
    await loader.writeReg(S3_RTC_CNTL_WDTWPROTECT_REG, S3_RTC_CNTL_WDT_WKEY)
    await loader.writeReg(S3_RTC_CNTL_WDTCONFIG1_REG, 2000)
  } catch (error) {
    return false
  }
  // The watchdog fires ~20ms after the arming write — often before the
  // arming or lock command's response makes it back, dropping the USB
  // device mid-exchange. Errors from here on mean the reset happened,
  // which is the success case.
  try {
    await loader.writeReg(S3_RTC_CNTL_WDTCONFIG0_REG, S3_RTC_WDT_RESET_CONFIG)
    await loader.writeReg(S3_RTC_CNTL_WDTWPROTECT_REG, 0)
  } catch (error) {}
  await sleep(500)
  return true
}

type FirmwareStatus = NonNullable<NonNullable<FrameType['embedded']>['firmware']>

function appendBrowserFlashLog(frameId: number, message: string): void {
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

function createUsbLogTerminal(frameId: number): FlashLogTerminal {
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

function mirrorTransportTrace(frameId: number, transport: EspTransport): void {
  const traceableTransport = transport as unknown as TraceableTransportInternals
  const originalTrace = traceableTransport.trace.bind(traceableTransport)
  traceableTransport.trace = (message: string): void => {
    const delta = Date.now() - (traceableTransport.lastTraceTime ?? Date.now())
    const logMessage = flashTraceLogMessage(message)
    if (logMessage) {
      appendEmbeddedUsbLogLine(frameId, `TRACE ${delta.toFixed(3)} ${logMessage}`)
    }
    originalTrace(message)
  }
}

async function fetchFirmwareStatus(frameId: number): Promise<FirmwareStatus> {
  const response = await apiFetch(`/api/frames/${frameId}/embedded/firmware`)
  if (!response.ok) {
    throw new Error('Failed to fetch firmware status')
  }
  const firmware = ((await response.json())?.firmware ?? {}) as FirmwareStatus
  framesModel.actions.updateEmbeddedFirmwareStatus(frameId, firmware)
  return firmware
}

async function startFirmwareBuild(frameId: number, force = false): Promise<FirmwareStatus> {
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

/** Make sure a fresh firmware image exists, building one if needed. */
async function ensureFirmwareReady(frameId: number, onStatus: (message: string) => void): Promise<FirmwareStatus> {
  let firmware = await fetchFirmwareStatus(frameId)
  if (firmware.status !== 'ready') {
    onStatus(
      firmware.status === 'stale'
        ? 'Rebuilding firmware from current settings'
        : firmware.status === 'missing'
        ? 'Rebuilding missing firmware image'
        : 'Building firmware image'
    )
    firmware = await startFirmwareBuild(frameId, firmware.status === 'stale' || firmware.status === 'missing')

    const deadline = Date.now() + FIRMWARE_POLL_TIMEOUT_MS
    let recoveryAttempts = 0
    while (firmware.status !== 'ready') {
      if (firmware.status === 'missing' || firmware.status === 'stale') {
        if (recoveryAttempts >= 2) {
          throw new Error(firmware.error || 'Firmware image needs to be rebuilt')
        }
        recoveryAttempts += 1
        onStatus(
          firmware.status === 'stale'
            ? 'Rebuilding firmware from current settings'
            : 'Rebuilding missing firmware image'
        )
        firmware = await startFirmwareBuild(frameId, true)
        continue
      }
      if (firmware.status === 'error') {
        throw new Error(firmware.error || 'Firmware build failed')
      }
      if (Date.now() > deadline) {
        throw new Error('Timed out waiting for the firmware build')
      }
      await sleep(FIRMWARE_POLL_INTERVAL_MS)
      firmware = await fetchFirmwareStatus(frameId)
    }
  }
  return firmware
}

async function downloadFirmware(downloadUrl: string): Promise<Uint8Array> {
  const response = await apiFetch(downloadUrl)
  if (!response.ok) {
    throw new Error('Failed to download firmware image')
  }
  return new Uint8Array(await response.arrayBuffer())
}

async function uploadScenesOverUsbAfterFlash(
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
  if (!text) {
    return 'USB API ready'
  }
  try {
    const status = JSON.parse(text)
    const parts = ['USB API ready']
    if (status.version) {
      parts.push(`version=${status.version}`)
    }
    if (status.config?.panel) {
      parts.push(`panel=${status.config.panel}`)
    }
    if (status.render?.count !== undefined) {
      parts.push(`renders=${status.render.count}`)
    }
    if (status.scenes?.loaded !== undefined) {
      parts.push(`scenes=${status.scenes.loaded}`)
    }
    return parts.join(' ')
  } catch (error) {
    return 'USB API ready'
  }
}

// Returns the port the board answered on: the watchdog reset after flashing
// re-enumerates the USB device, so the original SerialPort object may have
// been replaced by a fresh grant from getPorts().
async function waitForUsbApiReadyAfterFlash(
  frame: FrameType,
  port: SerialPort,
  onStatus: (message: string) => void
): Promise<SerialPort> {
  const started = Date.now()
  const deadline = started + POST_FLASH_USB_READY_TIMEOUT_MS
  let attempt = 0
  let lastError: unknown = null
  let resetHintShown = false
  onStatus('Waiting for board USB API. First boot after flashing formats onboard storage — this can take ~3 minutes.')

  while (Date.now() < deadline) {
    attempt += 1
    const livePort = await resolveLiveSerialPort(port)
    if (livePort && livePort !== port) {
      appendBrowserFlashLog(frame.id, 'USB device re-enumerated after reboot; switching to the new port.')
      port = livePort
    }
    try {
      const result = await runEmbeddedUsbApiCommand(frame.id, 'status', {
        port,
        timeoutMs: Math.min(POST_FLASH_USB_READY_COMMAND_TIMEOUT_MS, Math.max(1000, deadline - Date.now())),
        mirrorOutput: false,
        keepOpen: true,
      })
      appendBrowserFlashLog(frame.id, usbStatusSummary(result.text))
      return port
    } catch (error) {
      lastError = error
      if (attempt === 1 || attempt % 4 === 0) {
        const detail = error instanceof Error ? error.message : String(error)
        appendBrowserFlashLog(frame.id, `USB API not ready yet: ${detail}`)
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

function usbConnectionButtonLabel(usbLogStreamState: { status?: string } | undefined, usbLogStreamOpen: boolean): string {
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
  onBusyChange,
}: {
  frame: FrameType
  onBusyChange?: (busy: boolean) => void
}): JSX.Element {
  const [phase, setPhase] = useState<FlashPhase>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const { setDeployDrawerView } = useActions(frameLogic({ frameId: frame.id }))
  const { openFrameToolBehindDrawer } = useActions(workspaceLogic)
  const { usbLogStreamStatesByFrameId } = useValues(embeddedUsbLogsModel)

  const webSerialSupported = typeof navigator !== 'undefined' && 'serial' in navigator
  const busy = phase === 'connecting' || phase === 'preparing' || phase === 'flashing'
  const usbLogStreamState = usbLogStreamStatesByFrameId[frame.id]

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
    setDeployDrawerView('embedded')
    try {
      // Must run inside the click gesture, before any other await
      const activeLogPort = embeddedUsbLogStreamSessionPort(frame.id)
      port = activeLogPort ? await stopEmbeddedUsbLogStream(frame.id) : await navigator.serial.requestPort()
      if (!port) {
        setPhase('idle')
        setMessage(null)
        return
      }
      openFrameToolBehindDrawer(frame.id, 'logs')
      appendBrowserFlashLog(frame.id, 'USB port selected')

      // Loaded on demand: esptool-js adds ~380KB we only need when actually flashing
      const { ESPLoader, Transport } = await import('esptool-js')
      transport = new Transport(port, false)
      mirrorTransportTrace(frame.id, transport)
      flashTerminal = createUsbLogTerminal(frame.id)

      setFlashMessage('Connecting to the board')
      const loader = new ESPLoader({ transport, baudrate: 460800, enableTracing: true, terminal: flashTerminal })
      const chip = await loader.main()
      setFlashMessage(`Connected to ${chip}`)

      setPhase('preparing')
      const firmwareStatus = await ensureFirmwareReady(frame.id, setFlashMessage)
      const downloadUrl = firmwareStatus.downloadUrl || `/api/frames/${frame.id}/embedded/firmware/download`
      const flashOffset =
        parseInt(firmwareStatus.flashOffset || frame.embedded?.firmware?.flashOffset || '0x0', 16) || 0
      const flashSize = firmwareFlashSize(frame, firmwareStatus)
      setFlashMessage('Downloading firmware image')
      const firmware = await downloadFirmware(downloadUrl)

      setPhase('flashing')
      setFlashMessage(`Erasing ${flashSize} flash and flashing ${Math.round(firmware.length / 1024)}KB to ${chip}`)
      await loader.writeFlash({
        fileArray: [{ data: firmware, address: flashOffset }],
        flashSize,
        flashMode: 'keep',
        flashFreq: 'keep',
        // Browser flashing is our "known good" provisioning path. Erase first so
        // stale NVS, old RF calibration, or cached scenes from an earlier
        // partition layout cannot override the freshly baked frame defaults.
        eraseAll: true,
        compress: true,
        reportProgress: (_fileIndex, written, total) => {
          setProgress(total > 0 ? Math.round((written / total) * 100) : null)
        },
      })
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
      const displayMessage =
        /No port selected/i.test(detail)
          ? null
          : /Failed to open serial port/i.test(detail)
          ? 'Could not open the serial port. Close other serial monitors and try again.'
          : detail
      setMessage(displayMessage)
      if (/No port selected/i.test(detail)) {
        setPhase('idle')
      } else if (displayMessage) {
        appendBrowserFlashLog(frame.id, `Flash failed: ${displayMessage}`)
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
          } else {
            setPhase('done')
            setFlashMessage('Firmware flashed. No scenes configured to upload.')
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
        Flashing from the browser needs Web Serial, which this browser doesn't support. Use Chrome or Edge, or flash
        with the command above.
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={flash}
          disabled={busy}
          className="frameos-primary-action inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40"
        >
          {busy ? <Spinner color="white" /> : <BoltIcon className="h-4 w-4" />}
          {phase === 'flashing' && progress !== null
            ? `Flashing ${progress}%`
            : busy
            ? 'Flashing'
            : 'Flash from browser'}
        </button>
        <EmbeddedUsbConnectionButton frame={frame} disabled={busy} />
      </div>
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
