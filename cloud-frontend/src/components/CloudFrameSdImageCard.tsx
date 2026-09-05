import { DevicePhoneMobileIcon } from '@heroicons/react/24/outline'
import { useState } from 'react'
import type { ReactElement } from 'react'

import { normalizeBuildrootPlatform } from '../../../frontend/src/devices'
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

  // Only seed the board when the frame actually records one — normalize on a
  // missing value would hand back the raspberry-pi-64 default, which is a
  // guess, and a guessed board is exactly what does not survive being wrong.
  //
  // `frame.buildroot` is a backend-managed field the cloud's frameSummary has
  // never carried, so on this bundle the board came from nowhere and the
  // select always opened on "Pick a board…". `hardware.board` is the device's
  // own answer, sent at enrollment and refreshed on every hub hello (see
  // hardwarePayload in frameos/src/frameos/cloud/enrollment.nim); frames on
  // firmware that predates it still report none, and still get the
  // placeholder.
  const storedPlatform = frame.buildroot?.platform || frame.hardware?.board
  const buildrootPlatform = storedPlatform ? normalizeBuildrootPlatform(storedPlatform) : undefined

  // The display comes from the device's own `hardware` report, not from the
  // frame's settings: `device`, `width` and `height` are not in the cloud's
  // settings allowlist (src/lib/frames.ts — only `rotate` of the four is), so
  // frameSummary never carries them and seeding from frame.device alone left
  // every re-download on "pick the display later" for a frame whose panel the
  // cloud already knew. `hardware` is what the device sent at enrollment and
  // re-sends on every hub hello.
  const hardware = frame.hardware
  const seededDevice = frame.device || hardware?.device || undefined
  const seededWidth = frame.width ?? hardware?.width ?? undefined
  const seededHeight = frame.height ?? hardware?.height ?? undefined

  // Bound (re-enrollment) codes only: single-use, no frame quota. Minted per
  // build rather than cached, because one code can only ever key one card.
  // The lifetime is the builder's choice, as for a new frame's image.
  async function mintClaimToken(opts: { ttlDays?: number | 'forever' }): Promise<string> {
    const response = await fetch('/api/frames/claim-tokens', {
      body: JSON.stringify({
        frame_id: String(frame.id),
        ...(opts.ttlDays !== undefined ? { ttl_days: opts.ttlDays } : {}),
      }),
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
              device: seededDevice,
              width: seededWidth,
              height: seededHeight,
              rotate: frame.rotate,
              buildrootPlatform,
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
