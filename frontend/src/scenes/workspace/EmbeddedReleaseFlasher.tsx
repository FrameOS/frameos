import { useEffect, useState } from 'react'
import { CloudArrowDownIcon } from '@heroicons/react/24/outline'
import { useActions } from 'kea'

import { Spinner } from '../../components/Spinner'
import { startEmbeddedUsbLogStream } from '../../models/embeddedUsbLogsModel'
import { framesModel, scheduleEmbeddedUsbFrameImageRefresh } from '../../models/framesModel'
import type { FrameId, FrameType } from '../../types'
import { apiFetch } from '../../utils/apiFetch'
import { webSerialSupported as isWebSerialSupported } from '../../utils/webSerial'
import { flashAndSetUpBoard, type EmbeddedProvisioningPlan } from './embeddedFlashRun'
import { appendBrowserFlashLog, type FlashPhase } from './embeddedFlashShared'
import { planeFirmwareSource, releaseFirmwarePlatform } from './releaseFirmware'
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

export {
  provisionOverUsb,
  skippedSettingsNotice,
  type EmbeddedProvisioningPlan,
  type EmbeddedProvisioningSetting,
  type ProvisionOverUsbResult,
} from './embeddedFlashRun'

export async function fetchProvisioningPlan(frameId: FrameId): Promise<EmbeddedProvisioningPlan> {
  const response = await apiFetch(`/api/frames/${frameId}/embedded/provisioning`)
  if (!response.ok) {
    throw new Error('Could not work out what to provision this board with.')
  }
  return ((await response.json())?.provisioning ?? {}) as EmbeddedProvisioningPlan
}

/** Store the flash size esptool read off the board on the frame, so the
 * backend's OTA and provisioning answers describe the chip that is actually
 * there. Logs and carries on when the update fails. */
export async function recordDetectedFlashSize(
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

/** This frame's setup document (backend `GET …/embedded/setup`): the scenes
 * the board's own pull would get — one empty scene for a board this backend
 * renders for, the runtime's app keywords, no app test files — which is what
 * goes over the cable after a flash, never the workspace's list as it is. */
export async function fetchFrameSetupScenes(frameId: FrameId): Promise<unknown[]> {
  const response = await apiFetch(`/api/frames/${frameId}/embedded/setup`)
  if (!response.ok) {
    throw new Error('Could not read the scenes this frame is set up with.')
  }
  const scenes = (await response.json())?.scenes
  return Array.isArray(scenes) ? scenes : []
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
    // The click's own gesture opens the port prompt inside flashAndSetUpBoard,
    // so nothing may be awaited before it.
    const outcome = await flashAndSetUpBoard(
      {
        frameId: frame.id,
        setPhase,
        setProgress,
        setMessage,
        onPortTaken: () => openFrameToolBehindDrawer(frame.id, 'logs'),
      },
      {
        firmware: planeFirmwareSource(),
        chipPlatform: releaseFirmwarePlatform(frame),
        configuredPlatform: plan.releasePlatform || releaseFirmwarePlatform(frame),
        configuredFlashSize: plan.releaseFlashSize,
        plan,
        // Read once the board is up (nothing may be awaited before the port
        // prompt): the backend's answer at the time they go over the cable.
        scenes: () => fetchFrameSetupScenes(frame.id),
        onFlashSizeDetected: (flashSize, log) => recordDetectedFlashSize(frame, flashSize, log),
        onScenesUploaded: async () => {
          const completeResponse = await apiFetch(`/api/frames/${frame.id}/embedded/usb_deploy_complete`, {
            method: 'POST',
          })
          if (!completeResponse.ok) {
            throw new Error('Scene upload completed, but backend deploy state update failed')
          }
        },
      }
    )
    if (outcome.status === 'cancelled' || outcome.status === 'failed') {
      return
    }
    if (outcome.status === 'done') {
      framesModel.actions.loadFrame(frame.id)
      scheduleEmbeddedUsbFrameImageRefresh(frame.id)
    }
    const logStreamStarted = await startEmbeddedUsbLogStream(frame.id, outcome.port)
    openFrameToolBehindDrawer(frame.id, 'logs')
    if (!logStreamStarted) {
      appendBrowserFlashLog(frame.id, 'USB serial log stream could not be reopened after flashing.')
    }
  }

  // Nothing published for this chip (virtual), or nothing esptool can write
  // (the pico family's .uf2 goes onto a BOOTSEL drive by hand — the card
  // mounts PicoFirmwareCard instead and never this): the card says so on its
  // own, and an explanation nobody asked for is just noise.
  if (plan && (!plan.releasePlatform || plan.releaseFormat === 'uf2')) {
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
