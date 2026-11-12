import { ArrowRightIcon, CheckCircleIcon, ClipboardDocumentIcon } from '@heroicons/react/24/outline'
import { useState } from 'react'
import type { FormEvent, ReactElement } from 'react'

import { browserTimeZone } from '../lib/browser-time-zone'
import { cloudFrameUrl } from '../routes'

// "Add frame" → a virtual frame: no hardware. FrameOS Cloud renders its
// scenes and shows the picture at a private link, for a browser on a spare
// screen, an old tablet, a TV, a dashboard. Part of the paid plans
// (POST /api/frames/virtual answers 403 with the plan's number otherwise).
//
// Plain React like the rest of the panel: it is mounted only while its path
// is open, and what it makes is a frame the workspace then loads itself.

// Sizes people actually have a screen for. "Custom" opens the two fields.
const sizeChoices: { height: number; label: string; width: number }[] = [
  { height: 480, label: '800 × 480', width: 800 },
  { height: 720, label: '1280 × 720 (HD)', width: 1280 },
  { height: 1080, label: '1920 × 1080 (Full HD)', width: 1920 },
  { height: 1920, label: '1080 × 1920 (Full HD, portrait)', width: 1080 },
  { height: 768, label: '1024 × 768 (tablet)', width: 1024 },
]

// Mirrors virtualFrameMinDimension / MaxDimension in the cloud's
// virtual-frames.ts; the server is the one that refuses.
const minDimension = 16
const maxDimension = 4096

interface CreatedVirtualFrame {
  frameId: string
  name: string
  viewUrl: string
}

/** What to say for a refusal of POST /api/frames/virtual. */
export function virtualFrameErrorMessage(error: string | undefined, limit?: number): string {
  switch (error) {
    case 'cloud_rendered_frame_quota_exceeded':
      return limit && limit > 0
        ? `Your plan includes ${limit} virtual ${
            limit === 1 ? 'frame' : 'frames'
          }, and they are all in use. Delete one, or move to a larger plan.`
        : 'Virtual frames are part of the paid plans.'
    case 'invalid_size':
      return `Width and height are whole numbers from ${minDimension} to ${maxDimension}.`
    case 'size_too_large':
      return 'That is more pixels than one frame can have. Make it smaller.'
    case 'invalid_name':
      return 'That name will not work. Try a shorter one.'
    case 'login_required':
      return 'Your session expired. Sign in again to add a frame.'
    default:
      return 'Could not create the frame. Try again in a moment.'
  }
}

export function VirtualFrameForm(): ReactElement {
  const [name, setName] = useState('')
  const [size, setSize] = useState('0')
  const [width, setWidth] = useState('800')
  const [height, setHeight] = useState('480')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<{ code: string | undefined; limit?: number | undefined } | undefined>()
  const [created, setCreated] = useState<CreatedVirtualFrame | undefined>()
  const [copied, setCopied] = useState(false)
  const custom = size === 'custom'

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (submitting) {
      return
    }
    const choice = custom ? undefined : sizeChoices[Number(size)]
    const body = {
      height: choice ? choice.height : Number(height),
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(browserTimeZone() ? { timezone: browserTimeZone() } : {}),
      width: choice ? choice.width : Number(width),
    }
    setSubmitting(true)
    setError(undefined)
    try {
      const response = await fetch('/api/frames/virtual', {
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      const data = (await response.json().catch(() => ({}))) as {
        error?: string
        frame?: { id?: string; name?: string }
        max_cloud_rendered_frames?: number
        virtual?: { view_url?: string }
      }
      if (!response.ok || !data.frame?.id || !data.virtual?.view_url) {
        setError({ code: data.error, limit: data.max_cloud_rendered_frames })
        return
      }
      setCreated({ frameId: data.frame.id, name: data.frame.name || 'Virtual frame', viewUrl: data.virtual.view_url })
    } catch {
      setError({ code: 'network_error' })
    } finally {
      setSubmitting(false)
    }
  }

  if (created) {
    return (
      <div className="space-y-2 text-xs" data-testid="virtual-frame-created">
        <p className="frameos-strong flex items-start gap-1.5 text-sm font-semibold">
          <CheckCircleIcon aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" />
          <span>&ldquo;{created.name}&rdquo; is ready. Give it a scene and it starts drawing.</span>
        </p>
        <p className="frameos-muted">
          Open this link on the screen that should show it. Anyone with the link can see the picture, so keep it to
          yourself; you can replace it under the frame&apos;s settings.
        </p>
        <pre className="frameos-inset overflow-x-auto rounded-xl px-3 py-2 text-[11px] leading-relaxed [user-select:all]">
          {created.viewUrl}
        </pre>
        <div className="flex flex-wrap items-center gap-2">
          <a
            className="frameos-primary-action inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold text-white transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            data-testid="virtual-frame-open"
            href={cloudFrameUrl(created.frameId)}
          >
            Open frame
            <ArrowRightIcon aria-hidden className="h-4 w-4" />
          </a>
          <button
            className="frameos-secondary-button inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            onClick={() => {
              void navigator.clipboard.writeText(created.viewUrl).then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 2000)
              })
            }}
            type="button"
          >
            <ClipboardDocumentIcon aria-hidden className="h-4 w-4" />
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
      </div>
    )
  }

  const control =
    'frameos-control w-full rounded-lg border px-2.5 py-1.5 text-sm focus:border-blue-500 focus:ring-blue-500'
  return (
    <form className="space-y-3" onSubmit={(event) => void submit(event)}>
      <p className="frameos-muted text-xs">
        A frame with no hardware. FrameOS Cloud draws its scenes and shows the picture at a private link: open it in a
        browser on a spare screen, an old tablet or a TV. It draws while someone is looking, at most every five minutes.
      </p>
      <p className="frameos-muted text-xs">
        Its scenes run on FrameOS Cloud, not on a device of yours. A scene that needs one of your service keys uses it
        there, and scenes cannot reach your home network.
      </p>
      <label className="block text-xs">
        <span className="frameos-muted mb-1 block">Name</span>
        <input
          aria-label="Frame name"
          className={control}
          maxLength={256}
          onChange={(event) => setName(event.target.value)}
          placeholder="Virtual frame"
          type="text"
          value={name}
        />
      </label>
      <label className="block text-xs">
        <span className="frameos-muted mb-1 block">Size in pixels</span>
        <select aria-label="Size" className={control} onChange={(event) => setSize(event.target.value)} value={size}>
          {sizeChoices.map((choice, index) => (
            <option key={choice.label} value={String(index)}>
              {choice.label}
            </option>
          ))}
          <option value="custom">Custom</option>
        </select>
      </label>
      {custom ? (
        <div className="grid grid-cols-2 gap-2 text-xs">
          <label className="block">
            <span className="frameos-muted mb-1 block">Width</span>
            <input
              aria-label="Width"
              className={control}
              max={maxDimension}
              min={minDimension}
              onChange={(event) => setWidth(event.target.value)}
              required
              type="number"
              value={width}
            />
          </label>
          <label className="block">
            <span className="frameos-muted mb-1 block">Height</span>
            <input
              aria-label="Height"
              className={control}
              max={maxDimension}
              min={minDimension}
              onChange={(event) => setHeight(event.target.value)}
              required
              type="number"
              value={height}
            />
          </label>
        </div>
      ) : null}
      {error ? (
        <p className="frameos-warning-button rounded-xl border px-3 py-2 text-xs" role="alert">
          {virtualFrameErrorMessage(error.code, error.limit)}{' '}
          {error.code === 'cloud_rendered_frame_quota_exceeded' ? (
            <a className="font-semibold underline" href="/account/usage">
              See the plans
            </a>
          ) : null}
        </p>
      ) : null}
      <button
        className="frameos-primary-action inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold text-white transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-60"
        disabled={submitting}
        type="submit"
      >
        {submitting ? 'Creating…' : 'Create virtual frame'}
      </button>
    </form>
  )
}
