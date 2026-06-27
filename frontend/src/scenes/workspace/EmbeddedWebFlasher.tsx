import { useEffect, useState } from 'react'
import { BoltIcon, CommandLineIcon, StopCircleIcon } from '@heroicons/react/24/outline'
import { useActions, useValues } from 'kea'
import type { Transport as EspTransport } from 'esptool-js'

import { Spinner } from '../../components/Spinner'
import {
  embeddedUsbLogStreamSessionPort,
  embeddedUsbLogsModel,
  isEmbeddedUsbLogStreamOpen,
  startEmbeddedUsbLogStream,
  stopEmbeddedUsbLogStream,
} from '../../models/embeddedUsbLogsModel'
import type { FrameType } from '../../types'
import { apiFetch } from '../../utils/apiFetch'
import { workspaceLogic } from './workspaceLogic'

type FlashPhase = 'idle' | 'connecting' | 'preparing' | 'flashing' | 'done' | 'error'
type EspFlashSize = '4MB' | '8MB' | '16MB' | '32MB'

const FIRMWARE_POLL_INTERVAL_MS = 3000
const FIRMWARE_POLL_TIMEOUT_MS = 10 * 60 * 1000
const ESP_FLASH_SIZES = new Set<EspFlashSize>(['4MB', '8MB', '16MB', '32MB'])

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type FirmwareStatus = NonNullable<NonNullable<FrameType['embedded']>['firmware']>

async function fetchFirmwareStatus(frameId: number): Promise<FirmwareStatus> {
  const response = await apiFetch(`/api/frames/${frameId}/embedded/firmware`)
  if (!response.ok) {
    throw new Error('Failed to fetch firmware status')
  }
  return ((await response.json())?.firmware ?? {}) as FirmwareStatus
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
    onStatus('Building firmware image')
    const response = await apiFetch(`/api/frames/${frameId}/embedded/firmware`, { method: 'POST' })
    if (!response.ok) {
      let detail = 'Failed to start firmware build'
      try {
        detail = (await response.json())?.detail || detail
      } catch (error) {}
      throw new Error(detail)
    }
    firmware = ((await response.json())?.firmware ?? {}) as FirmwareStatus

    const deadline = Date.now() + FIRMWARE_POLL_TIMEOUT_MS
    while (firmware.status !== 'ready') {
      if (firmware.status === 'error' || firmware.status === 'missing' || firmware.status === 'stale') {
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
  const { openFrameTool } = useActions(workspaceLogic)
  const { stopUsbLogStream } = useActions(embeddedUsbLogsModel)
  const { usbLogStreamStatesByFrameId } = useValues(embeddedUsbLogsModel)

  const webSerialSupported = typeof navigator !== 'undefined' && 'serial' in navigator
  const busy = phase === 'connecting' || phase === 'preparing' || phase === 'flashing'
  const usbLogStreamState = usbLogStreamStatesByFrameId[frame.id]
  const usbLogStreamOpen = isEmbeddedUsbLogStreamOpen(usbLogStreamState)
  const usbLogStreamBusy =
    usbLogStreamState?.status === 'selecting' ||
    usbLogStreamState?.status === 'connecting' ||
    usbLogStreamState?.status === 'stopping'

  useEffect(() => {
    onBusyChange?.(busy)
  }, [busy, onBusyChange])

  useEffect(() => {
    return () => onBusyChange?.(false)
  }, [onBusyChange])

  const flash = async (): Promise<void> => {
    let port: SerialPort | null = null
    let transport: EspTransport | null = null
    let streamLogsAfterFlash = false
    setPhase('connecting')
    setProgress(null)
    setMessage('Selecting USB port')
    try {
      // Must run inside the click gesture, before any other await
      const activeLogPort = embeddedUsbLogStreamSessionPort(frame.id)
      port = activeLogPort ? await stopEmbeddedUsbLogStream(frame.id) : await navigator.serial.requestPort()
      if (!port) {
        setPhase('idle')
        setMessage(null)
        return
      }

      // Loaded on demand: esptool-js adds ~380KB we only need when actually flashing
      const { ESPLoader, Transport } = await import('esptool-js')
      transport = new Transport(port, false)

      setMessage('Connecting to the board')
      const loader = new ESPLoader({ transport, baudrate: 460800 })
      const chip = await loader.main()
      setMessage(`Connected to ${chip}`)

      setPhase('preparing')
      const firmwareStatus = await ensureFirmwareReady(frame.id, setMessage)
      const downloadUrl = firmwareStatus.downloadUrl || `/api/frames/${frame.id}/embedded/firmware/download`
      const flashOffset =
        parseInt(firmwareStatus.flashOffset || frame.embedded?.firmware?.flashOffset || '0x0', 16) || 0
      const flashSize = firmwareFlashSize(frame, firmwareStatus)
      setMessage('Downloading firmware image')
      const firmware = await downloadFirmware(downloadUrl)

      setPhase('flashing')
      setMessage(`Erasing ${flashSize} flash and flashing ${Math.round(firmware.length / 1024)}KB to ${chip}`)
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
      // esptool-js's built-in hard reset never asserts RTS, which leaves
      // USB-Serial/JTAG boards (e.g. XIAO ESP32-S3) stuck in the flasher
      // stub. Pulse the reset line the way the esptool CLI does.
      await transport.setDTR(false)
      await transport.setRTS(true)
      await sleep(100)
      await transport.setRTS(false)
      await transport.setDTR(false)

      setPhase('done')
      setProgress(null)
      setMessage('Firmware flashed. The board is rebooting.')
      streamLogsAfterFlash = true
    } catch (error) {
      setPhase('error')
      setProgress(null)
      const detail = error instanceof Error ? error.message : String(error)
      setMessage(
        /No port selected/i.test(detail)
          ? null
          : /Failed to open serial port/i.test(detail)
          ? 'Could not open the serial port. Close other serial monitors and try again.'
          : detail
      )
      if (/No port selected/i.test(detail)) {
        setPhase('idle')
      }
    } finally {
      if (transport) {
        try {
          await transport.disconnect()
        } catch (error) {}
      }
      if (streamLogsAfterFlash && port) {
        await startEmbeddedUsbLogStream(frame.id, port)
        openFrameTool(frame.id, 'logs')
      }
    }
  }

  const streamUsbLogs = async (): Promise<void> => {
    const started = await startEmbeddedUsbLogStream(frame.id)
    if (started) {
      openFrameTool(frame.id, 'logs')
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
        <button
          type="button"
          onClick={usbLogStreamOpen ? () => stopUsbLogStream(frame.id) : streamUsbLogs}
          disabled={busy || usbLogStreamBusy}
          className="frameos-secondary-button inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40"
        >
          {usbLogStreamState?.status === 'selecting' || usbLogStreamState?.status === 'connecting' ? (
            <Spinner />
          ) : usbLogStreamOpen ? (
            <StopCircleIcon className="h-4 w-4" />
          ) : (
            <CommandLineIcon className="h-4 w-4" />
          )}
          {usbLogStreamOpen ? 'Stop USB logs' : 'Stream USB logs'}
        </button>
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
