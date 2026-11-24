import { useEffect, useState } from 'react'
import { ArrowUpCircleIcon } from '@heroicons/react/24/outline'
import { useActions, useValues } from 'kea'

import { Checkbox } from '../../components/Checkbox'
import { Spinner } from '../../components/Spinner'
import { frameLogic } from '../frame/frameLogic'
import { frameRendersOnServer } from '../../utils/renderOnServer'
import { workspaceMode } from './workspaceSurfaces'
import { startEmbeddedUsbLogStream } from '../../models/embeddedUsbLogsModel'
import { framesModel } from '../../models/framesModel'
import type { FrameType } from '../../types'
import { webSerialSupported as isWebSerialSupported, webSerialUnavailableReason } from '../../utils/webSerial'
import { appendBrowserFlashLog, type FlashPhase } from './embeddedFlashShared'
import { updateBoardKeepingSettings } from './embeddedFlashRun'
import { frameHardwarePlatform, planeFirmwareSource, releaseFirmwarePlatformForFrame } from './releaseFirmware'
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

// The release listing, the image download and its signature check live in
// releaseFirmware.ts, shared with the blank-board flasher and
// flash.frameos.net; re-exported here for this module's older importers.
export {
  downloadReleaseFirmware,
  fetchReleaseFirmwareListing,
  hasReleaseFirmwarePlatform,
  releaseFirmwarePlatform,
  releaseFirmwarePlatformForFrame,
  saveReleaseFirmwareFile,
  type ReleaseFirmwareAsset,
  type ReleaseFirmwareListing,
} from './releaseFirmware'

export function EmbeddedUsbFirmwareUpdate({
  frame,
  onBusyChange,
  label = 'Update over USB',
}: {
  frame: FrameType
  // The Connect-over-USB card keeps its connected layout while this flow holds
  // the port (the log stream it keys on is closed for the duration).
  onBusyChange?: (busy: boolean) => void
  label?: string
}): JSX.Element {
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
  // A board its plane renders for is sent none of its scenes
  // (docs/server-rendering.md "Nothing to keep on the board"): no tick.
  const plane = workspaceMode()
  const offerScenes = plane === 'frameAdmin' || !frameRendersOnServer(frame, plane)

  const webSerialSupported = isWebSerialSupported()
  const busy = phase === 'connecting' || phase === 'preparing' || phase === 'flashing'

  useEffect(() => {
    onBusyChange?.(busy)
  }, [busy, onBusyChange])

  useEffect(() => {
    return () => onBusyChange?.(false)
  }, [onBusyChange])

  useEffect(() => {
    setPhase('idle')
    setMessage(null)
    setProgress(null)
  }, [frame.id])

  const update = async (): Promise<void> => {
    // The click's own gesture opens the port prompt inside
    // updateBoardKeepingSettings, so nothing may be awaited before it.
    const outcome = await updateBoardKeepingSettings(
      {
        frameId: frame.id,
        setPhase,
        setProgress,
        setMessage,
        onPortTaken: () => openFrameToolBehindDrawer(frame.id, 'logs'),
      },
      {
        firmware: planeFirmwareSource(),
        knownChip: frameHardwarePlatform(frame) || undefined,
        // The backend's provisioning answer / the per-chip generic image only
        // when the board's partition table cannot be read.
        fallbackPlatform: () => releaseFirmwarePlatformForFrame(frame),
        scenes: offerScenes && alsoPushScenes ? scenes : null,
      }
    )
    if (outcome.status === 'cancelled' || outcome.status === 'failed') {
      return
    }
    // Its reported firmware version changes as soon as it re-syncs.
    if (outcome.status === 'done') {
      loadFrame(frame.id)
    }
    const logStreamStarted = await startEmbeddedUsbLogStream(frame.id, outcome.port)
    openFrameToolBehindDrawer(frame.id, 'logs')
    if (!logStreamStarted) {
      appendBrowserFlashLog(frame.id, 'USB serial log stream could not be reopened after the update.')
    }
  }

  if (!webSerialSupported) {
    return <div className="frame-tool-muted text-xs leading-5">{webSerialUnavailableReason('Updating over USB')}</div>
  }

  return (
    <div className="space-y-2">
      {offerScenes ? (
        <Checkbox
          label="Also deploy scenes & settings"
          value={alsoPushScenes}
          onChange={setAlsoPushScenes}
          disabled={busy || scenes.length === 0}
          title={
            scenes.length === 0
              ? 'This frame has no scenes to push'
              : 'After the board reboots on the new firmware, send it the workspace’s current scenes over the same cable. Settings still arrive when the frame next connects.'
          }
        />
      ) : null}
      {/* Its own block under the tick, at a width that fits every label:
          the checkbox is inline, so an inline button shared its line and
          hopped to the next one each time "Updating 7%" grew a digit. */}
      <div>
        <button
          type="button"
          onClick={update}
          disabled={busy}
          className="frameos-secondary-button inline-flex min-w-[11rem] items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold tabular-nums transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40"
        >
          {busy ? <Spinner /> : <ArrowUpCircleIcon className="h-4 w-4" />}
          {phase === 'flashing' && progress !== null ? `Updating ${progress}%` : busy ? 'Updating' : label}
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
    </div>
  )
}
