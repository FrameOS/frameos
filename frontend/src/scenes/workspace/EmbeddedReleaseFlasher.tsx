import { useEffect, useState } from 'react'
import { CloudArrowDownIcon } from '@heroicons/react/24/outline'
import { useActions } from 'kea'
import type { Transport as EspTransport } from 'esptool-js'

import { Spinner } from '../../components/Spinner'
import {
  embeddedUsbLogStreamSessionPort,
  prepareSerialPortReconnect,
  resolveLiveSerialPort,
  startEmbeddedUsbLogStream,
  stopEmbeddedUsbLogStream,
  usbProvisionWifi,
  usbRestart,
  usbSet,
  waitForEmbeddedUsbApiIdle,
  type EmbeddedUsbConfigKey,
} from '../../models/embeddedUsbLogsModel'
import { framesModel, scheduleEmbeddedUsbFrameImageRefresh } from '../../models/framesModel'
import type { FrameId, FrameType } from '../../types'
import { apiFetch } from '../../utils/apiFetch'
import { webSerialSupported as isWebSerialSupported, webSerialUnavailableReason } from '../../utils/webSerial'
import { detectFlashSize, layoutMatchedPlatform } from './embeddedFlashImage'
import {
  downloadReleaseFirmware,
  fetchReleaseFirmwareListing,
  releaseFirmwarePlatform,
} from './EmbeddedUsbFirmwareUpdate'
import {
  POST_FLASH_BOOT_WAIT_MS,
  appendBrowserFlashLog,
  createUsbLogTerminal,
  loadEsptoolForFlash,
  recordTransportTrace,
  sleep,
  uploadScenesOverUsbAfterFlash,
  waitForUsbApiReadyAfterFlash,
  watchdogResetAfterFlash,
  type FlashLogTerminal,
  type FlashPhase,
  type FlashTraceRecorder,
} from './embeddedFlashShared'
import { workspaceLogic } from './workspaceLogic'

// Flash a BLANK board from the published release and provision it over the
// same cable.
//
// Every panel driver is compiled into every release image, and each value a
// frame needs has a `set` key on the device's USB console, so the stock
// generic image for the board's chip and flash layout plus this frame's
// command list IS this frame — the shape the cloud's enrollment flasher has
// always used (Esp32CloudFlasher.tsx). The self-hosted backend builds no
// firmware of its own.
//
// The command list is the backend's (embedded_provisioning_plan), not this
// component's: the backend knows the frame, and it also reports what cannot
// go over the cable (the frame's HTTPS certificate rides the first settings
// pull instead) and what would leave the board unusable (no backend to talk
// to), for which the button is refused.
//
// The counterpart for a board that is already enrolled is
// EmbeddedUsbFirmwareUpdate: same release bytes, but written around the NVS
// partition so the device keeps the settings this flow is here to establish.

const PROVISION_COMMAND_TIMEOUT_MS = 15000

export interface EmbeddedProvisioningSetting {
  key: EmbeddedUsbConfigKey
  value: string
  secret: boolean
}

export interface EmbeddedProvisioningPlan {
  supported: boolean
  platform: string
  releasePlatform: string | null
  releaseFlashSize: string | null
  blockers: string[]
  warnings: string[]
  settings: EmbeddedProvisioningSetting[]
  wifi: { ssid: string; password: string } | null
}

export async function fetchProvisioningPlan(frameId: FrameId): Promise<EmbeddedProvisioningPlan> {
  const response = await apiFetch(`/api/frames/${frameId}/embedded/provisioning`)
  if (!response.ok) {
    throw new Error('Could not work out what to provision this board with.')
  }
  return ((await response.json())?.provisioning ?? {}) as EmbeddedProvisioningPlan
}

// Console keys that arrived with the release-image provisioning work
// (2026-09-03). A board still on older release firmware answers "unknown key"
// for them, and would otherwise stop the replay at the first one. They are a
// warning instead: every one of them also rides the backend's settings pull
// (hostname as `name`; the admin login, TLS and the HTTP cap on firmware that
// knows them), so the frame ends up correct once the board is on a current
// release. Anything else refused is a real failure.
const OPTIONAL_ON_OLDER_FIRMWARE: ReadonlySet<EmbeddedUsbConfigKey> = new Set<EmbeddedUsbConfigKey>([
  'hostname',
  'max_http_response_bytes',
  'admin_user',
  'admin_pass',
  'admin_auth',
  'tls_enable',
  'tls_port',
])

export interface ProvisionOverUsbResult {
  /** Keys the board refused because its firmware predates them. */
  skipped: EmbeddedUsbConfigKey[]
}

/**
 * Replay the plan over the board's USB API, in the order the backend gave it:
 * `set hardware` applies a whole board bundle (panel, EPD wiring, buttons, TF
 * socket), so everything this frame overrides on top of it has to come after.
 *
 * Wi-Fi goes last and reboots the board, because that is the point at which it
 * is finished — a board that reconnects half-provisioned would call home as
 * something that is not quite this frame.
 */
export async function provisionOverUsb(
  frameId: FrameId,
  plan: EmbeddedProvisioningPlan,
  // The flasher holds the port it just flashed through; the USB setup card
  // has none and lets each command open the board's USB session itself.
  port: SerialPort | null,
  onStatus: (message: string) => void
): Promise<ProvisionOverUsbResult> {
  const total = plan.settings.length
  const skipped: EmbeddedUsbConfigKey[] = []
  for (const [index, setting] of plan.settings.entries()) {
    onStatus(
      `Provisioning the board (${index + 1}/${total}): ${setting.key}${setting.secret ? '' : ` = ${setting.value}`}`
    )
    try {
      await usbSet(frameId, setting.key, setting.value, {
        ...(port ? { port, keepOpen: true } : {}),
        timeoutMs: PROVISION_COMMAND_TIMEOUT_MS,
      })
    } catch (error) {
      if (!OPTIONAL_ON_OLDER_FIRMWARE.has(setting.key)) {
        throw error
      }
      skipped.push(setting.key)
      onStatus(`The board's firmware does not know ${setting.key} yet; it takes effect after a firmware update.`)
    }
  }
  return { skipped }
}

/** Store the flash size esptool read off the board on the frame, so the
 * backend's OTA and provisioning answers describe the chip that is actually
 * there. Logs and carries on when the update fails. */
async function recordDetectedFlashSize(
  frame: FrameType,
  flashSize: string,
  log: (message: string) => void
): Promise<void> {
  try {
    // `layout` and `firmware` on the loaded frame are derived by the backend
    // per response; echoing them back would store a stale snapshot.
    const { layout: _layout, firmware: _firmware, ...embedded } = (frame.embedded ?? {}) as Record<string, unknown>
    const response = await apiFetch(`/api/frames/${frame.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embedded: { ...embedded, flashSize } }),
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    log(`Saved the board's ${flashSize} flash size on this frame.`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    log(`Could not save the board's ${flashSize} flash size on this frame (${detail}); set it under Frame settings.`)
  }
}

export function skippedSettingsNotice(skipped: EmbeddedUsbConfigKey[]): string | null {
  if (skipped.length === 0) {
    return null
  }
  return (
    `This board's firmware predates ${skipped.join(', ')}; those settings apply once it runs a current ` +
    'FrameOS release (Update over the air, or Update over USB).'
  )
}

export function EmbeddedReleaseFlasher({
  frame,
  disabled = false,
  onBusyChange,
  label = 'Flash latest release',
  primary = false,
}: {
  frame: FrameType
  disabled?: boolean
  onBusyChange?: (busy: boolean) => void
  // The Connect-over-USB card names the button by the situation it answers
  // ("Flash FrameOS & set up this frame" on a silent board, "Erase & flash
  // FrameOS again" under More) and makes it the primary action when it is
  // the one thing to do.
  label?: string
  primary?: boolean
}): JSX.Element | null {
  const [phase, setPhase] = useState<FlashPhase>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [plan, setPlan] = useState<EmbeddedProvisioningPlan | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  const { openFrameToolBehindDrawer } = useActions(workspaceLogic)

  const webSerialSupported = isWebSerialSupported()
  const busy = phase === 'connecting' || phase === 'preparing' || phase === 'flashing'

  useEffect(() => {
    onBusyChange?.(busy)
  }, [busy, onBusyChange])

  useEffect(() => {
    return () => onBusyChange?.(false)
  }, [onBusyChange])

  // Fetched up front, not on click: whether this frame can be provisioned at
  // all decides whether the button appears, and its warnings are what the user
  // needs BEFORE choosing this over a build.
  useEffect(() => {
    let cancelled = false
    setPhase('idle')
    setMessage(null)
    setProgress(null)
    setPlan(null)
    setPlanError(null)
    fetchProvisioningPlan(frame.id)
      .then((fetched) => {
        if (!cancelled) {
          setPlan(fetched)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setPlanError(error instanceof Error ? error.message : String(error))
        }
      })
    return () => {
      cancelled = true
    }
  }, [frame.id])

  const flash = async (): Promise<void> => {
    if (!plan) {
      return
    }
    let port: SerialPort | null = null
    let transport: EspTransport | null = null
    let flashTerminal: FlashLogTerminal | null = null
    let traceRecorder: FlashTraceRecorder | null = null
    let flashed = false
    let detectedFlashSize: string | null = null
    let flashSizeDiffersFromFrame = false
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

      setPhase('connecting')
      setFlashMessage('Connecting to the board')
      const loader = new ESPLoader({ transport, baudrate: 460800, enableTracing: true, terminal: flashTerminal })
      const chip = await loader.main()

      // The image is picked by the chip in front of us, not by the frame's
      // configured flash size: a merged image carries its partition table and
      // a flash-size header, and one built for a bigger chip boot-loops on a
      // smaller one ("Detected size(4096k) smaller than the size in the binary
      // image header(8192k)" — a 4 MB C3 dev board on a frame left at the
      // 8 MB default, 2026-09-05). The frame's own answer is the fallback when
      // the size cannot be read, the same order the cloud flasher uses.
      setPhase('preparing')
      const configuredPlatform = plan.releasePlatform || releaseFirmwarePlatform(frame)
      detectedFlashSize = await detectFlashSize(loader)
      const releasePlatform = detectedFlashSize
        ? layoutMatchedPlatform(releaseFirmwarePlatform(frame), detectedFlashSize, listing.assets)
        : configuredPlatform
      if (!detectedFlashSize) {
        setFlashMessage(
          `Could not read the board's flash size; using the ${releasePlatform} image this frame is configured for.`
        )
      } else if (releasePlatform === configuredPlatform) {
        setFlashMessage(`Flash size ${detectedFlashSize}: using the ${releasePlatform} image.`)
      } else {
        flashSizeDiffersFromFrame = true
        setFlashMessage(
          `Flash size ${detectedFlashSize}: this frame is set up for a ${plan.releaseFlashSize ?? 'different'} chip, ` +
            `so using the ${releasePlatform} image built for the board instead of ${configuredPlatform}.`
        )
      }
      const firmware = await downloadReleaseFirmware(releasePlatform, setFlashMessage, listing)

      setPhase('flashing')
      setFlashMessage(`Flashing ${firmware.name} to ${chip}`)
      await loader.writeFlash({
        // The merged provisioning image is the whole flash from 0x0
        // (bootloader, partition table, blank otadata, app), so it goes down
        // as one write. Nothing is spared: this board is not yet a frame, and
        // its settings are about to be provisioned from scratch anyway.
        fileArray: [{ address: 0x0, data: firmware.bytes }],
        flashSize: 'keep',
        flashMode: 'keep',
        flashFreq: 'keep',
        eraseAll: false,
        compress: true,
        reportProgress: (_fileIndex, written, total) => {
          setProgress(total > 0 ? Math.min(100, Math.round((written / total) * 100)) : null)
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
      if (flashed && port) {
        try {
          if (flashSizeDiffersFromFrame && detectedFlashSize) {
            // The board now runs the layout for its real chip; the frame record
            // is what the OTA offer and the next provisioning plan read, so it
            // follows the chip. Best effort: a failure here leaves a note, not
            // a half-provisioned board.
            await recordDetectedFlashSize(frame, detectedFlashSize, setFlashMessage)
          }
          await sleep(POST_FLASH_BOOT_WAIT_MS)
          port = await waitForUsbApiReadyAfterFlash(frame, port, setFlashMessage)
          const { skipped } = await provisionOverUsb(frame.id, plan, port, setMessage)
          appendBrowserFlashLog(
            frame.id,
            `Provisioned ${plan.settings.length - skipped.length} of ${plan.settings.length} setting(s) over USB.`
          )
          const notice = skippedSettingsNotice(skipped)
          if (notice) {
            appendBrowserFlashLog(frame.id, notice)
          }

          // Scenes before the Wi-Fi reboot: the board is up and answering, and
          // pushing them now saves a second boot wait. A frame with none gets
          // them from the backend once it connects.
          if (await uploadScenesOverUsbAfterFlash(frame, port, setFlashMessage)) {
            const completeResponse = await apiFetch(`/api/frames/${frame.id}/embedded/usb_deploy_complete`, {
              method: 'POST',
            })
            if (!completeResponse.ok) {
              throw new Error('Scene upload completed, but backend deploy state update failed')
            }
          }

          if (plan.wifi) {
            setFlashMessage(`Joining ${plan.wifi.ssid} and restarting`)
            await usbProvisionWifi(frame.id, plan.wifi.ssid, plan.wifi.password, { port, keepOpen: true })
          } else {
            setFlashMessage('Restarting the board')
            await usbRestart(frame.id, { port, keepOpen: true })
          }
          // That reboot re-enumerates the USB device, so the port object the
          // log stream below is handed has to be the replacement, not the one
          // that went away with the reset.
          port = (await resolveLiveSerialPort(port)) ?? port

          framesModel.actions.loadFrame(frame.id)
          scheduleEmbeddedUsbFrameImageRefresh(frame.id)
          setPhase('done')
          setFlashMessage(
            plan.wifi
              ? `Flashed the published firmware and provisioned this frame. The board is joining ${plan.wifi.ssid}.`
              : 'Flashed the published firmware and provisioned this frame. Add a Wi-Fi network, or join one from the board’s setup portal.'
          )
        } catch (error) {
          setPhase('error')
          const detail = error instanceof Error ? error.message : String(error)
          setFlashMessage(
            `Firmware written, but provisioning did not finish: ${detail} The board is running FrameOS — ` +
              'flash again to retry, or set the remaining values from "Set up over USB".'
          )
        }
        const logStreamStarted = await startEmbeddedUsbLogStream(frame.id, port)
        openFrameToolBehindDrawer(frame.id, 'logs')
        if (!logStreamStarted) {
          appendBrowserFlashLog(frame.id, 'USB serial log stream could not be reopened after flashing.')
        }
      }
    }
  }

  // Nothing published for this chip (pico, virtual): the card says so on its
  // own, and an explanation nobody asked for is just noise.
  if (plan && !plan.releasePlatform) {
    return null
  }
  if (!webSerialSupported) {
    return null
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={flash}
        disabled={disabled || busy || !plan?.supported}
        title={
          plan && !plan.supported
            ? plan.blockers.join(' ')
            : 'Write the latest published firmware and provision this frame over the same cable.'
        }
        className={`${
          primary ? 'frameos-primary-action' : 'frameos-secondary-button'
        } inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40`}
      >
        {busy ? <Spinner color={primary ? 'white' : undefined} /> : <CloudArrowDownIcon className="h-4 w-4" />}
        {phase === 'flashing' && progress !== null ? `Flashing ${progress}%` : busy ? 'Flashing' : label}
      </button>
      {planError ? (
        <div className="frame-tool-muted text-xs leading-5">{planError}</div>
      ) : plan && !plan.supported ? (
        <div className="frame-tool-muted text-xs leading-5">
          This frame cannot be flashed yet: {plan.blockers.join(' ')}
        </div>
      ) : plan ? (
        <div className="frame-tool-muted text-xs leading-5">
          Writes the published {plan.releasePlatform} image (or the one built for the flash size the board reports) and
          provisions this frame over USB. Everything the board needs is sent over the cable afterwards.
          {plan.warnings.length > 0 ? (
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {plan.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
        </div>
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
    </div>
  )
}
