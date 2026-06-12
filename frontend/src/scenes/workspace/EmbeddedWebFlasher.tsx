import { useState } from 'react'
import { BoltIcon } from '@heroicons/react/24/outline'

import { Spinner } from '../../components/Spinner'
import type { FrameType } from '../../types'
import { apiFetch } from '../../utils/apiFetch'

type FlashPhase = 'idle' | 'connecting' | 'preparing' | 'flashing' | 'done' | 'error'

const FIRMWARE_POLL_INTERVAL_MS = 3000
const FIRMWARE_POLL_TIMEOUT_MS = 10 * 60 * 1000

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

/** Make sure a fresh firmware image exists, building one if needed. Returns its download URL. */
async function ensureFirmwareReady(frameId: number, onStatus: (message: string) => void): Promise<string> {
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
  return firmware.downloadUrl || `/api/frames/${frameId}/embedded/firmware/download`
}

async function downloadFirmware(downloadUrl: string): Promise<Uint8Array> {
  const response = await apiFetch(downloadUrl)
  if (!response.ok) {
    throw new Error('Failed to download firmware image')
  }
  return new Uint8Array(await response.arrayBuffer())
}

export function EmbeddedWebFlasher({ frame }: { frame: FrameType }): JSX.Element {
  const [phase, setPhase] = useState<FlashPhase>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | null>(null)

  const flashOffset = parseInt(frame.embedded?.firmware?.flashOffset || '0x0', 16) || 0
  const webSerialSupported = typeof navigator !== 'undefined' && 'serial' in navigator
  const busy = phase === 'connecting' || phase === 'preparing' || phase === 'flashing'

  const flash = async (): Promise<void> => {
    // Must run inside the click gesture, before any other await
    const port = await navigator.serial.requestPort()
    // Loaded on demand: esptool-js adds ~380KB we only need when actually flashing
    const { ESPLoader, Transport } = await import('esptool-js')
    const transport = new Transport(port, false)
    setProgress(null)
    try {
      setPhase('connecting')
      setMessage('Connecting to the board')
      const loader = new ESPLoader({ transport, baudrate: 460800 })
      const chip = await loader.main()
      setMessage(`Connected to ${chip}`)

      setPhase('preparing')
      const downloadUrl = await ensureFirmwareReady(frame.id, setMessage)
      setMessage('Downloading firmware image')
      const firmware = await downloadFirmware(downloadUrl)

      setPhase('flashing')
      setMessage(`Flashing ${Math.round(firmware.length / 1024)}KB to ${chip}`)
      await loader.writeFlash({
        fileArray: [{ data: firmware, address: flashOffset }],
        flashSize: 'keep',
        flashMode: 'keep',
        flashFreq: 'keep',
        eraseAll: false,
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
      try {
        await transport.disconnect()
      } catch (error) {}
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
      <button
        type="button"
        onClick={flash}
        disabled={busy}
        className="frameos-primary-action inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40"
      >
        {busy ? <Spinner color="white" /> : <BoltIcon className="h-4 w-4" />}
        {phase === 'flashing' && progress !== null ? `Flashing ${progress}%` : busy ? 'Flashing' : 'Flash from browser'}
      </button>
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
    </div>
  )
}
