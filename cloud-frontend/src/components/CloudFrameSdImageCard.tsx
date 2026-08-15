import { DevicePhoneMobileIcon } from '@heroicons/react/24/outline'
import { useState } from 'react'
import type { ReactElement } from 'react'

import type { FrameType } from '../../../frontend/src/types'
import { cloudOrigin } from '../cloudConfig'
import { SdImageBuilder } from './SdImageBuilder'

/**
 * "Write another SD card" in a cloud Raspberry Pi frame's deploy drawer.
 *
 * The SD image builder used to exist only inside "Add frame", which made it a
 * one-shot: install a frame from a card and there was no way back to the
 * builder for that frame — a dead card, a replacement Pi or a move to
 * different hardware meant enrolling a second frame and abandoning the first,
 * scenes and all.
 *
 * The image built here embeds a claim code bound to THIS frame, so the card
 * re-keys the existing row on first boot (the claim-tokens route's `frame_id`
 * path) instead of creating a new one. Scenes follow automatically — the cloud
 * pushes the assigned set as soon as the device connects. Assets do not: they
 * are files on the old card's disk and the image carries none of them.
 *
 * Collapsed by default. Building an image is a deliberate, slow act (it
 * downloads and rewrites 1–2 GB) and it does not belong open above the deploy
 * controls people came here for.
 *
 * Registered into the shared drawer through addFramePanelRegistry — frontend/
 * must never import this bundle (see that file's note).
 */
export function CloudFrameSdImageCard({ frame }: { frame: FrameType }): ReactElement {
  const [open, setOpen] = useState(false)

  // Bound (re-enrollment) codes only: single-use, one-hour, no frame quota.
  // Minted per build rather than cached, because one code can only ever key
  // one card.
  async function mintClaimToken(): Promise<string> {
    const response = await fetch('/api/frames/claim-tokens', {
      body: JSON.stringify({ frame_id: String(frame.id) }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    const data = (await response.json().catch(() => ({}))) as {
      claim_token?: string
      error?: string
    }
    if (!response.ok || !data.claim_token) {
      throw new Error(
        data.error === 'frame_revoked'
          ? 'This frame’s link was revoked — delete it and enroll a new one instead.'
          : data.error ?? 'claim_token_failed'
      )
    }
    return data.claim_token
  }

  return (
    <section className="space-y-2">
      <div className="frame-tool-card space-y-3 rounded-[22px] p-4">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="frameos-secondary-button inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        >
          <DevicePhoneMobileIcon aria-hidden className="h-4 w-4" />
          {open ? 'Hide SD card image' : 'Write another SD card'}
        </button>
        {open ? (
          <SdImageBuilder
            cloudOrigin={cloudOrigin()}
            mintClaimToken={mintClaimToken}
            reenrollFrame={{
              id: String(frame.id),
              name: frame.name || 'this frame',
              // Seed the display picker from what the frame already runs —
              // "pick the display later" is the wrong default for hardware
              // that is already configured. All still editable in the form.
              device: frame.device,
              width: frame.width,
              height: frame.height,
              rotate: frame.rotate,
            }}
          />
        ) : (
          <div className="frame-tool-muted text-xs leading-4">
            Build another card for this frame — a replacement Pi, a dead card, different hardware. It comes back as this
            same frame and its scenes are pushed down automatically; its assets stay on the old card.
          </div>
        )}
      </div>
    </section>
  )
}
