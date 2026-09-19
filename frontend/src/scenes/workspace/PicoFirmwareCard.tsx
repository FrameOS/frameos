import { useActions, useValues } from 'kea'
import { ArrowDownTrayIcon } from '@heroicons/react/24/outline'

import { Spinner } from '../../components/Spinner'
import type { FrameType } from '../../types'
import { embeddedUsbConnectLogic } from './embeddedUsbConnectLogic'
import { firmwareSizeLabel, picoBoardLabel } from './picoFirmware'

// Step 1 of installing FrameOS on a Pico W / Pico 2 W (Pimoroni Inky Frame):
// get the .uf2 onto the board. Step 2 is the "Connect over USB" card
// underneath (EmbeddedUsbConnect), which the two share their state with
// (embeddedUsbConnectLogic) — this file is a template over it.
//
// There is no flasher to build here. A Pico's flash is written by its UF2
// bootloader, which shows up as a USB drive; copying a file onto a drive is
// the one thing a web page cannot do for a person, so the ceiling is a
// same-origin download of the release asset (through the backend's release
// pipe, like the ESP32 flashers' bytes) and steps short enough to follow with
// the board in one hand.
//
// Self-hosted backend only: FrameOS Cloud publishes no pico assets.

const RELEASES_URL = 'https://github.com/FrameOS/frameos/releases/latest'

const primaryButtonClass =
  'frameos-primary-action inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40'

function ReleasesLink({ children }: { children: string }): JSX.Element {
  return (
    <a href={RELEASES_URL} target="_blank" rel="noreferrer" className="underline">
      {children}
    </a>
  )
}

export function PicoFirmwareCard({ frame }: { frame: FrameType }): JSX.Element {
  const logic = embeddedUsbConnectLogic({ frameId: frame.id, frame })
  const {
    uf2Asset,
    uf2Platform,
    bootselDrive,
    releaseListing,
    releaseListingFailed,
    latestRelease,
    downloadBusy,
    firmwareNotice,
  } = useValues(logic)
  const { downloadFirmware } = useActions(logic)
  const expectedFileName = `frameos-<version>-${uf2Platform}.uf2`

  return (
    <div className="frame-tool-card space-y-4 rounded-[22px] p-4">
      <div>
        <div className="text-sm font-semibold text-[color:var(--tool-strong)]">1. Get the firmware onto the board</div>
        <div className="frame-tool-muted mt-1 text-sm leading-5">
          Every {picoBoardLabel(uf2Platform)} runs the same signed FrameOS release. A browser cannot write a Pico&apos;s
          flash, so this part is a file copy: download the .uf2 and drop it on the board&apos;s bootloader drive.
        </div>
      </div>

      {uf2Asset ? (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={downloadFirmware} disabled={downloadBusy} className={primaryButtonClass}>
            {downloadBusy ? <Spinner color="white" /> : <ArrowDownTrayIcon className="h-4 w-4" />}
            {downloadBusy ? 'Downloading' : 'Download firmware (.uf2)'}
          </button>
          <span className="frame-tool-muted min-w-0 break-all text-xs leading-4">
            {uf2Asset.name}
            {latestRelease ? ` · FrameOS ${latestRelease}` : ''}
            {firmwareSizeLabel(uf2Asset.size) ? ` · ${firmwareSizeLabel(uf2Asset.size)}` : ''}
          </span>
        </div>
      ) : releaseListing ? (
        <div className="frameos-warning-button rounded-xl border px-3 py-2 text-sm leading-5">
          {latestRelease ? `FrameOS ${latestRelease}` : 'The latest FrameOS release'} does not publish a {uf2Platform}{' '}
          firmware file yet — it predates the Pico build. Look for <code>{expectedFileName}</code> on the{' '}
          <ReleasesLink>GitHub releases page</ReleasesLink>, or build it from <code>embedded/pico</code>.
        </div>
      ) : releaseListingFailed ? (
        <div className="frameos-warning-button rounded-xl border px-3 py-2 text-sm leading-5">
          Could not look up the latest FrameOS release from this backend. Download <code>{expectedFileName}</code> from
          the <ReleasesLink>GitHub releases page</ReleasesLink> instead.
        </div>
      ) : (
        <div className="flex items-center gap-2 text-sm font-semibold text-[color:var(--tool-strong)]">
          <Spinner />
          Looking up the latest release
        </div>
      )}
      {firmwareNotice ? (
        <div className={`text-xs font-semibold ${firmwareNotice.isError ? 'text-red-500' : 'text-green-600'}`}>
          {firmwareNotice.text}
        </div>
      ) : null}

      <ol className="list-decimal space-y-1.5 pl-5 text-sm leading-5 text-[color:var(--tool-strong)]">
        <li>
          Hold the <span className="font-semibold">BOOTSEL</span> button on the Pico while plugging its USB cable into
          this computer, then let go.{' '}
          <span className="frame-tool-muted">
            Already running FrameOS? Skip the button: connect in step 2 and press “Reboot into BOOTSEL”.
          </span>
        </li>
        <li>
          A drive named <span className="font-semibold">{bootselDrive}</span> appears.
        </li>
        <li>
          Drag the downloaded <code>.uf2</code> file onto it.
        </li>
        <li>
          The drive disappears and the board restarts into FrameOS on its own.{' '}
          <span className="frame-tool-muted">It does not know which frame it is yet — that is step 2.</span>
        </li>
      </ol>
    </div>
  )
}
