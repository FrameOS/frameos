import { useEffect, useState } from 'react'
import { ArrowUpCircleIcon } from '@heroicons/react/24/outline'
import { useActions, useValues } from 'kea'
import type { Transport as EspTransport } from 'esptool-js'

import { Checkbox } from '../../components/Checkbox'
import { Spinner } from '../../components/Spinner'
import { frameLogic } from '../frame/frameLogic'
import { pushScenesOverUsb, pushedScenesMessage } from './embeddedUsbScenePush'
import {
  embeddedUsbLogStreamSessionPort,
  prepareSerialPortReconnect,
  startEmbeddedUsbLogStream,
  stopEmbeddedUsbLogStream,
  waitForEmbeddedUsbApiIdle,
} from '../../models/embeddedUsbLogsModel'
import { framesModel } from '../../models/framesModel'
import type { FrameType } from '../../types'
import { apiFetch } from '../../utils/apiFetch'
import { webSerialSupported as isWebSerialSupported, webSerialUnavailableReason } from '../../utils/webSerial'
import {
  POST_FLASH_BOOT_WAIT_MS,
  appendBrowserFlashLog,
  createUsbLogTerminal,
  loadEsptoolForFlash,
  recordTransportTrace,
  sleep,
  waitForUsbApiReadyAfterFlash,
  watchdogResetAfterFlash,
  type FlashLogTerminal,
  type FlashPhase,
  type FlashTraceRecorder,
} from './embeddedFlashShared'
import {
  ESP32_PARTITION_TABLE_OFFSET,
  ESP32_PARTITION_TABLE_SIZE,
  deviceLayoutMatchesPlan,
  firmwareUpdateWritePlan,
  layoutPlatformForPartitions,
  parseEsp32PartitionTable,
  partitionTableFlashMb,
  type Esp32Partition,
  type FirmwareUpdateWritePlan,
} from './embeddedFlashImage'
import { workspaceLogic } from './workspaceLogic'

// USB firmware update for a frame that is ALREADY enrolled — the counterpart
// of the cloud's "Add frame" flasher, which enrolls a blank board.
//
// The two differ in exactly one way, and it is the important one: this flow
// never touches the NVS partition and never mints a claim token, so the board
// keeps its Wi-Fi credentials and its cloud identity and comes back as the
// same frame. (Flashing the merged image at 0x0 the way enrollment does would
// blank the NVS along with everything else — the account would then own an
// orphaned row and a board that no longer knows about it.) See
// embeddedFlashImage.ts for the write plan and why it is derived from the
// image's own partition table.
//
// Firmware bytes come from the control plane's release pipe, same as
// enrollment: /api/frames/firmware serves the published image so the browser
// never talks to api.github.com (no CORS, 60 req/h per IP).

const firmwareListingUrl = '/api/frames/firmware'
const releasePlatformByHardware: Record<string, string> = {
  'esp32-s3': 'esp32-s3-generic',
  'esp32-c3': 'esp32-c3-generic',
}

/** The platform string this frame is known by: what the device reported at
 * enrollment (cloud frames) or the configured embedded platform (backend
 * frames, which have no device-reported hardware). */
function frameHardwarePlatform(frame: FrameType): string {
  return (frame.hardware?.platform ?? frame.embedded?.platform ?? '').toLowerCase()
}

/** Whether a published release asset is known for this frame's platform —
 * the gate for offering the release updater on self-hosted backend frames. */
export function hasReleaseFirmwarePlatform(frame: FrameType): boolean {
  return frameHardwarePlatform(frame) in releasePlatformByHardware
}

export interface ReleaseFirmwareAsset {
  name: string
  platform: string
  size: number
}

export interface ReleaseFirmwareListing {
  assets?: ReleaseFirmwareAsset[]
  release?: string
}

/** Which published asset fits this frame's chip: the generic image, the
 * answer when nothing better is known (see releaseFirmwarePlatformForFrame). */
export function releaseFirmwarePlatform(frame: FrameType): string {
  return releasePlatformByHardware[frameHardwarePlatform(frame)] ?? 'esp32-s3-generic'
}

/** The fallback when the board's own partition table cannot be read: the
 * control plane's answer for this frame — the image built for its configured
 * flash layout (esp32-c3-16mb for a 16MB XTEINK X4, esp32-s3-32mb for a 13.3E6
 * board) when the release publishes one — and the per-chip generic image
 * wherever the provisioning route does not exist (the cloud) or cannot
 * answer. With a readable table the update picks the image by the table
 * itself (layoutPlatformForPartitions), which is the only one it can write. */
export async function releaseFirmwarePlatformForFrame(frame: FrameType): Promise<string> {
  try {
    const response = await apiFetch(`/api/frames/${frame.id}/embedded/provisioning`)
    if (response.ok) {
      const platform = (await response.json())?.provisioning?.releasePlatform
      if (typeof platform === 'string' && platform) {
        return platform
      }
    }
  } catch {
    // The static per-chip answer below is what this flow always used.
  }
  return releaseFirmwarePlatform(frame)
}

/** The published release and its assets — also how the deploy drawer learns
 * "latest is vY" to compare against the device-reported frameos_version.
 * Note `release` keeps its "v" prefix; device versions do not. */
export async function fetchReleaseFirmwareListing(): Promise<ReleaseFirmwareListing> {
  const listingResponse = await apiFetch(firmwareListingUrl)
  if (!listingResponse.ok) {
    throw new Error('Could not look up the latest FrameOS release.')
  }
  return (await listingResponse.json()) as ReleaseFirmwareListing
}

export async function downloadReleaseFirmware(
  platform: string,
  log: (message: string) => void,
  knownListing?: ReleaseFirmwareListing
): Promise<{ bytes: Uint8Array; name: string; release: string }> {
  const listing = knownListing ?? (await fetchReleaseFirmwareListing())
  const asset = listing.assets?.find((entry) => entry.platform === platform)
  if (!asset) {
    throw new Error(`Release ${listing.release || '?'} publishes no ${platform} firmware to update to.`)
  }
  log(`Downloading ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)`)
  const response = await apiFetch(`${firmwareListingUrl}?platform=${encodeURIComponent(platform)}`, {
    cache: 'no-store',
  })
  if (!response.ok) {
    throw new Error('Could not download the firmware image.')
  }
  return { bytes: new Uint8Array(await response.arrayBuffer()), name: asset.name, release: listing.release ?? '' }
}

/**
 * The partition table on the board, or null when it cannot be read — some
 * chips/stubs decline flash reads, and a blank board has none. It decides two
 * things: which release image to fetch (the one built for this layout, see
 * layoutPlatformForPartitions) and whether the NVS-sparing plan is safe to
 * write (assertDeviceLayoutMatches).
 */
async function readDevicePartitionTable(
  loader: { readFlash?: (address: number, size: number) => Promise<Uint8Array> },
  log: (message: string) => void
): Promise<Esp32Partition[] | null> {
  if (typeof loader.readFlash !== 'function') {
    return null
  }
  let table: Uint8Array
  try {
    table = await loader.readFlash(ESP32_PARTITION_TABLE_OFFSET, ESP32_PARTITION_TABLE_SIZE)
  } catch (error) {
    log("Could not read the board's partition table; trusting the image's own layout.")
    return null
  }
  const partitions = parseEsp32PartitionTable(table)
  if (partitions.length === 0) {
    log("The board has no readable partition table yet; trusting the image's own layout.")
    return null
  }
  return partitions
}

/** 'esp32-c3' / 'esp32-s3' for this frame: what it reported at enrollment,
 * else what esptool just said it is talking to. */
function chipPlatformFor(frame: FrameType, chipDescription: string): string {
  const known = frameHardwarePlatform(frame)
  if (known) {
    return known
  }
  return /esp32-c3/i.test(chipDescription) ? 'esp32-c3' : 'esp32-s3'
}

/**
 * Refuse the update when the board is partitioned differently from the image:
 * the hole this plan leaves would then land somewhere other than the board's
 * NVS, wiping the credentials it exists to protect. An unreadable table is not
 * treated as a mismatch, but then the guarantee rests on the image alone.
 */
function assertDeviceLayoutMatches(partitions: Esp32Partition[] | null, plan: FirmwareUpdateWritePlan): void {
  if (!partitions) {
    return
  }
  if (!deviceLayoutMatchesPlan(partitions, plan)) {
    throw new Error(
      'This board is partitioned differently from the published firmware, so its settings partition cannot be ' +
        'spared. Re-enroll it from the "Add frame" panel instead.'
    )
  }
}

export function EmbeddedUsbFirmwareUpdate({ frame }: { frame: FrameType }): JSX.Element {
  const [phase, setPhase] = useState<FlashPhase>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const { openFrameToolBehindDrawer } = useActions(workspaceLogic)
  const { loadFrame } = useActions(framesModel)
  const { frameForm } = useValues(frameLogic({ frameId: frame.id }))
  // Same tick the over-the-air firmware card offers, for the same reason: one
  // press should converge the board. The flash keeps the settings partition,
  // so a board that comes back on the new firmware is still running whatever
  // scenes it had — which is rarely what you wanted when you pulled out a
  // cable to update it.
  const [alsoPushScenes, setAlsoPushScenes] = useState(true)
  const scenes = frameForm?.scenes ?? frame.scenes ?? []

  const webSerialSupported = isWebSerialSupported()
  const busy = phase === 'connecting' || phase === 'preparing' || phase === 'flashing'

  useEffect(() => {
    setPhase('idle')
    setMessage(null)
    setProgress(null)
  }, [frame.id])

  const update = async (): Promise<void> => {
    let port: SerialPort | null = null
    let transport: EspTransport | null = null
    let flashTerminal: FlashLogTerminal | null = null
    let traceRecorder: FlashTraceRecorder | null = null
    let flashed = false
    const setFlashMessage = (nextMessage: string | null): void => {
      setMessage(nextMessage)
      if (nextMessage) {
        appendBrowserFlashLog(frame.id, nextMessage)
      }
    }

    setPhase('connecting')
    setProgress(null)
    setFlashMessage('Selecting USB port')
    try {
      // Must run inside the click gesture, before any other await, or the
      // browser refuses the port prompt.
      const activeLogPort = embeddedUsbLogStreamSessionPort(frame.id)
      port = activeLogPort ? await stopEmbeddedUsbLogStream(frame.id) : await navigator.serial.requestPort()
      if (!port) {
        setPhase('idle')
        setMessage(null)
        return
      }
      await prepareSerialPortReconnect(port)
      // A USB API command still in flight (a `status` probe, a `restart`)
      // holds the port and resumes the log stream on it when it ends; opening
      // it underneath fails with "The port is already open". Wait it out,
      // then take the port back from the stream it may have restarted.
      await waitForEmbeddedUsbApiIdle(frame.id)
      if (embeddedUsbLogStreamSessionPort(frame.id)) {
        port = (await stopEmbeddedUsbLogStream(frame.id)) ?? port
      }
      openFrameToolBehindDrawer(frame.id, 'logs')

      setPhase('preparing')
      const listing = await fetchReleaseFirmwareListing()

      // Loaded on demand: esptool-js adds ~380KB we only need when flashing.
      const { ESPLoader, Transport } = await loadEsptoolForFlash()
      transport = new Transport(port, false)
      traceRecorder = recordTransportTrace(frame.id, transport)
      flashTerminal = createUsbLogTerminal(frame.id)

      setFlashMessage('Connecting to the board')
      const loader = new ESPLoader({ transport, baudrate: 460800, enableTracing: true, terminal: flashTerminal })
      const chip = await loader.main()

      // The board's own partition table picks the image: an update must keep
      // the layout the board has (that is what spares its NVS), and the
      // release publishes one image per layout — a board enrolled on the
      // 16/32 MB image gets that image again, not the generic one, which
      // this flow used to fetch unconditionally on the cloud and then refuse
      // as "partitioned differently". The backend's provisioning answer /
      // the per-chip generic image only when the table cannot be read.
      const log = (line: string): void => appendBrowserFlashLog(frame.id, line)
      const devicePartitions = await readDevicePartitionTable(loader, log)
      let platform: string
      if (devicePartitions) {
        platform = layoutPlatformForPartitions(chipPlatformFor(frame, chip), devicePartitions, listing.assets)
        const mb = partitionTableFlashMb(devicePartitions)
        log(
          mb === null
            ? `The board's partition table matches no published layout; using the ${platform} image.`
            : `The board is partitioned for ${mb}MB: updating with the ${platform} image.`
        )
      } else {
        platform = await releaseFirmwarePlatformForFrame(frame)
      }
      const firmware = await downloadReleaseFirmware(platform, setFlashMessage, listing)
      // Planned and checked against the board before anything is written: a
      // plan that cannot spare the NVS must fail while the flash is untouched.
      const plan = firmwareUpdateWritePlan(firmware.bytes)
      assertDeviceLayoutMatches(devicePartitions, plan)

      setPhase('flashing')
      setFlashMessage(
        `Flashing ${firmware.name} to ${chip}, keeping the frame's Wi-Fi and cloud settings (${
          plan.preserved.name
        }, ${Math.round(plan.preserved.size / 1024)}KB).`
      )
      // reportProgress counts per segment; weight them into one bar.
      const segmentOffsets = plan.segments.map((_, index) =>
        plan.segments.slice(0, index).reduce((total, segment) => total + segment.data.byteLength, 0)
      )
      await loader.writeFlash({
        fileArray: plan.segments.map((segment) => ({ address: segment.address, data: segment.data })),
        flashSize: 'keep',
        flashMode: 'keep',
        flashFreq: 'keep',
        // eraseAll would take the whole chip, NVS included — the entire point
        // of this flow is that it does not.
        eraseAll: false,
        compress: true,
        reportProgress: (fileIndex, written, total) => {
          const done = (segmentOffsets[fileIndex] ?? 0) + (total > 0 ? written : 0)
          setProgress(plan.totalBytes > 0 ? Math.min(100, Math.round((done / plan.totalBytes) * 100)) : null)
        },
      })
      flashed = true
      traceRecorder.expectReboot()

      if (!(await watchdogResetAfterFlash(loader))) {
        try {
          await transport.setDTR(false)
          await transport.setRTS(true)
          await sleep(100)
          await transport.setRTS(false)
          await transport.setDTR(false)
        } catch (error) {
          // The port drops if the chip already reset mid-command; the
          // post-flash wait re-acquires it.
        }
      }
      setPhase('preparing')
      setProgress(null)
      setFlashMessage('Firmware written. Waiting for the board to reboot.')
    } catch (error) {
      setPhase('error')
      setProgress(null)
      const detail = error instanceof Error ? error.message : String(error)
      if (/No port selected/i.test(detail)) {
        setPhase('idle')
        setMessage(null)
      } else {
        const displayMessage = /Failed to open serial port/i.test(detail)
          ? 'Could not open the serial port. Close other serial monitors and try again.'
          : detail
        setMessage(displayMessage)
        appendBrowserFlashLog(frame.id, `Firmware update failed: ${displayMessage}`)
        traceRecorder?.dumpAfterFailure()
      }
    } finally {
      flashTerminal?.flush()
      if (transport) {
        try {
          await transport.disconnect()
        } catch (error) {}
      }
      if (flashed && port) {
        try {
          await sleep(POST_FLASH_BOOT_WAIT_MS)
          port = await waitForUsbApiReadyAfterFlash(
            frame,
            port,
            setFlashMessage,
            'Waiting for the board to come back on USB.'
          )
          // Scenes ride the same USB session, after the board answers again:
          // the freshly flashed firmware is what has to accept them, and its
          // usb_api is only up once waitForUsbApiReadyAfterFlash returns. A
          // failure here is reported as its own thing — the firmware update
          // itself already succeeded and must not be reported as failed.
          if (alsoPushScenes && scenes.length > 0) {
            setFlashMessage(`Pushing ${scenes.length} scene${scenes.length === 1 ? '' : 's'} over USB.`)
            try {
              await pushScenesOverUsb(frame.id, scenes)
              setPhase('done')
              setFlashMessage(
                `Firmware updated and ${pushedScenesMessage(scenes.length).toLowerCase()} ` +
                  'The frame kept its Wi-Fi and cloud settings and is reconnecting.'
              )
            } catch (pushError) {
              setPhase('error')
              const detail = pushError instanceof Error ? pushError.message : String(pushError)
              setFlashMessage(`Firmware updated, but pushing the scenes over USB failed: ${detail}`)
            }
          } else {
            setPhase('done')
            setFlashMessage('Firmware updated. The frame kept its Wi-Fi and cloud settings and is reconnecting.')
          }
          // Its reported firmware version changes as soon as it re-syncs.
          loadFrame(frame.id)
        } catch (error) {
          setPhase('error')
          const detail = error instanceof Error ? error.message : String(error)
          setFlashMessage(`Firmware written, but the board did not answer over USB afterwards: ${detail}`)
        }
        const logStreamStarted = await startEmbeddedUsbLogStream(frame.id, port)
        openFrameToolBehindDrawer(frame.id, 'logs')
        if (!logStreamStarted) {
          appendBrowserFlashLog(frame.id, 'USB serial log stream could not be reopened after the update.')
        }
      }
    }
  }

  if (!webSerialSupported) {
    return <div className="frame-tool-muted text-xs leading-5">{webSerialUnavailableReason('Updating over USB')}</div>
  }

  return (
    <div className="space-y-2">
      <Checkbox
        label="Also push scenes & settings"
        value={alsoPushScenes}
        onChange={setAlsoPushScenes}
        disabled={busy || scenes.length === 0}
        title={
          scenes.length === 0
            ? 'This frame has no scenes to push'
            : 'After the board reboots on the new firmware, send it the workspace’s current scenes over the same cable. Settings still arrive when the frame next connects.'
        }
      />
      <button
        type="button"
        onClick={update}
        disabled={busy}
        className="frameos-secondary-button inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40"
      >
        {busy ? <Spinner /> : <ArrowUpCircleIcon className="h-4 w-4" />}
        {phase === 'flashing' && progress !== null ? `Updating ${progress}%` : busy ? 'Updating' : 'Update over USB'}
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
