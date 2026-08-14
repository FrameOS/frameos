import { ArrowPathIcon } from '@heroicons/react/24/outline'
import { useState } from 'react'
import type { ReactElement } from 'react'

import type { FrameType } from '../../../frontend/src/types'
import { cloudOrigin } from '../cloudConfig'
import { Esp32CloudFlasher } from './Esp32CloudFlasher'

/**
 * "Re-link this board" at the bottom of a cloud ESP32 frame's deploy → Over
 * USB view.
 *
 * This is the destructive sibling of the firmware update above it. The updater
 * writes around the settings partition, so it needs the board to still know
 * who it is; a board that was factory-reset or erased whole no longer does,
 * and nothing on that screen could bring it back. This writes the merged image
 * INCLUDING the NVS, with a claim token minted bound to THIS frame — so the
 * board comes back as this frame rather than as a new one, keeping its scenes,
 * assets and logs.
 *
 * It used to be a fifth entry in "Add frame", which is the wrong place twice
 * over: it acts on a frame that already exists, and you had to leave the frame
 * to find it. Collapsed behind a disclosure because it is rare and it does ask
 * for the Wi-Fi credentials again.
 *
 * Registered into the shared drawer through addFramePanelRegistry — frontend/
 * must never import this bundle (see that file's note).
 */
export function CloudFrameUsbRelink({ frame }: { frame: FrameType }): ReactElement {
  const [open, setOpen] = useState(false)

  return (
    <section className="space-y-2">
      <div className="frame-tool-card space-y-3 rounded-[22px] p-4">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="frameos-secondary-button inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        >
          <ArrowPathIcon aria-hidden className="h-4 w-4" />
          {open ? 'Hide re-link' : 'Re-link a wiped board'}
        </button>
        {open ? (
          <>
            <div className="frame-tool-muted text-sm leading-5">
              For a board that was factory-reset or fully erased and no longer knows it is this frame — the update above
              cannot help it, because it deliberately leaves the settings partition alone. This writes the whole image,
              settings included, and links the board back to{' '}
              <span className="font-semibold text-[color:var(--tool-strong)]">{frame.name || 'this frame'}</span>: its
              scenes, assets and logs carry over. Wi-Fi has to be entered again.
            </div>
            <Esp32CloudFlasher
              cloudOrigin={cloudOrigin()}
              reenrollFrame={{ id: String(frame.id), name: frame.name || 'this frame' }}
            />
          </>
        ) : (
          <div className="frame-tool-muted text-xs leading-4">
            Factory-reset or fully erased boards have lost their link to this frame; this puts it back.
          </div>
        )}
      </div>
    </section>
  )
}
