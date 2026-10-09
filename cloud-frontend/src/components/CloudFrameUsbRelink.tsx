import { ArrowPathIcon } from '@heroicons/react/24/outline'
import { useState } from 'react'
import type { ReactElement } from 'react'

import type { FrameType } from '../../../frontend/src/types'
import { cloudOrigin } from '../cloudConfig'
import { Esp32CloudFlasher } from './Esp32CloudFlasher'

/**
 * "Re-link a wiped board" in a cloud ESP32 frame's Over USB view: flashes the
 * whole image, NVS included, with a claim token bound to this frame, so an
 * erased board comes back as this frame instead of a new one.
 *
 * Registered into the shared drawer through addFramePanelRegistry; frontend/
 * must never import this bundle.
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
              For a board that was factory-reset or erased and no longer knows it is this frame. This flashes FrameOS
              and links the board back to{' '}
              <span className="font-semibold text-[color:var(--tool-strong)]">{frame.name || 'this frame'}</span>. Its
              scenes, assets and logs stay. You need to enter the Wi-Fi details again.
            </div>
            <Esp32CloudFlasher
              cloudOrigin={cloudOrigin()}
              reenrollFrame={{ id: String(frame.id), name: frame.name || 'this frame' }}
            />
          </>
        ) : (
          <div className="frame-tool-muted text-xs leading-4">
            Use this when a factory reset or erase cut the board's link to this frame.
          </div>
        )}
      </div>
    </section>
  )
}
