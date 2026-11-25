import { useActions, useValues } from 'kea'
import {
  ArrowDownTrayIcon,
  ArrowTopRightOnSquareIcon,
  ArrowUpCircleIcon,
  CloudArrowDownIcon,
  Cog6ToothIcon,
} from '@heroicons/react/24/outline'

import { Spinner } from '../../components/Spinner'
import type { FrameType } from '../../types'
import { flasherUrl } from '../../utils/flasherBridge'
import { frameRendersOnServer } from '../../utils/renderOnServer'
import { webSerialUnavailableReason } from '../../utils/webSerial'
import { flasherBridgeLogic } from './flasherBridgeLogic'

// The frame's USB card on a page with no Web Serial (EmbeddedUsbConnect):
// the same three things it offers on a secure page — flash a blank board,
// update one keeping its settings, send this frame's settings — done by
// flash.frameos.net in a window of its own (flasherBridgeLogic,
// cloud/docs/flasher.md), plus the setup file for a flasher on another
// computer.

const secondaryButtonClass =
  'frameos-secondary-button inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40'
const primaryButtonClass =
  'frameos-primary-action inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40'

export function FlasherBridgeCard({ frame, uf2 }: { frame: FrameType; uf2: boolean }): JSX.Element {
  const logic = flasherBridgeLogic({ frameId: frame.id, frame })
  const { status, kind, phase, message, progress, error, busy, downloadBusy, windowOpen } = useValues(logic)
  const { start, focusWindow, closeWindow, downloadSetupFile } = useActions(logic)
  const flasherHost = new URL(flasherUrl()).host
  // A board its backend renders for is sent the one empty scene, which the
  // setup document already is; pushing it after an update is still right.
  const pushScenes = !frameRendersOnServer(frame, 'backend')

  return (
    <div className="space-y-3">
      <div className="frame-tool-muted text-xs leading-5">
        {webSerialUnavailableReason('Talking to the board over USB')} {flasherHost} can do the USB part for this page:
        it opens in a window of its own, gets this frame’s setup from here, and shows what it will write before it
        touches the board. Nothing about the frame goes anywhere else. Use Chrome or Edge.
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {uf2 ? (
          <button
            type="button"
            onClick={() => start('provision', { withWifi: true })}
            disabled={busy}
            className={primaryButtonClass}
          >
            <Cog6ToothIcon className="h-4 w-4" />
            Apply settings with {flasherHost}
          </button>
        ) : (
          <>
            <button type="button" onClick={() => start('setup')} disabled={busy} className={primaryButtonClass}>
              <CloudArrowDownIcon className="h-4 w-4" />
              Flash FrameOS & set up this frame
            </button>
            <button
              type="button"
              onClick={() => start('update', { pushScenes })}
              disabled={busy}
              className={secondaryButtonClass}
            >
              <ArrowUpCircleIcon className="h-4 w-4" />
              Update firmware, keep settings
            </button>
            <button type="button" onClick={() => start('provision')} disabled={busy} className={secondaryButtonClass}>
              <Cog6ToothIcon className="h-4 w-4" />
              Apply frame settings
            </button>
          </>
        )}
        <button type="button" onClick={downloadSetupFile} disabled={busy} className={secondaryButtonClass}>
          {downloadBusy ? <Spinner /> : <ArrowDownTrayIcon className="h-4 w-4" />}
          Download setup file
        </button>
      </div>
      <div className="frame-tool-muted text-xs leading-5">
        The setup file is this frame’s settings, Wi-Fi and scenes for {flasherHost} on another computer. It holds the
        frame’s API key and Wi-Fi password: keep it to yourself and delete it when you are done.
      </div>
      {windowOpen ? (
        <div className="flex flex-wrap items-center gap-2">
          <Spinner />
          <span className="text-xs leading-5 text-[color:var(--tool-strong)]">
            {status === 'waiting'
              ? `Opening ${flasherHost}…`
              : `${kind === 'provision' ? 'Applying settings' : kind === 'update' ? 'Updating' : 'Flashing'} in the ${flasherHost} window. Keep this tab open.`}
          </span>
          <button type="button" onClick={focusWindow} className={secondaryButtonClass}>
            <ArrowTopRightOnSquareIcon className="h-4 w-4" />
            Show the window
          </button>
          <button type="button" onClick={closeWindow} className={secondaryButtonClass}>
            Close it
          </button>
        </div>
      ) : status === 'closed' && phase !== 'done' ? (
        <div className="frame-tool-muted text-xs leading-5">The {flasherHost} window was closed.</div>
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
      {error ? <div className="text-xs font-semibold text-red-500">{error}</div> : null}
    </div>
  )
}
