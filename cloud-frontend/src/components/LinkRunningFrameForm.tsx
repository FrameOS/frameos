import { ArrowRightIcon, CheckCircleIcon, LinkIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline'
import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactElement } from 'react'

import { cloudFrameUrl } from '../routes'
import { fetchFrameList, useEnrollmentWatch } from './enrollmentWatch'
import type { FrameListEntry } from './enrollmentWatch'

// "Link a frame that already runs", inside the Add-frame drawer.
//
// The frame side is the device flow (docs/cloud-link.md): the frame asks the
// cloud for a code, shows it on its panel / admin page, and polls until
// someone signed in to an account approves that code. The approval used to
// live only on /device, so this path in the drawer was a paragraph sending
// you there and back. The same three calls the /device page makes fit in the
// drawer: look the code up (GET /api/device/request), approve it (POST
// /api/device/authorize), then watch the frames list until the newly linked
// frame shows up and open it — the frame enrols itself the moment it sees
// the approval, so there is nothing else to click.
//
// Deliberately NOT a copy of DeviceApprovalPanel (auth-web, a different React
// app): no "did you open this from a link" confirmation — the code is typed
// here, never carried in the URL — and no sign-in callout, because the
// workspace is only reachable signed in.

export interface DeviceLinkRequest {
  client_kind?: 'backend' | 'frame'
  expires_at: string
  local_origin?: string | null
  public_display_name: string
  requested_scopes: string[]
  scope_change?: boolean
  status: 'pending' | 'approved' | 'denied' | 'expired'
  user_code: string
}

// Approving needs a session that proved its credentials within the approval
// window (POST /api/device/authorize answers 403 reauth_required otherwise).
// The reauth page comes back to this URL; the drawer is closed by then, so
// the code is parked here and the panel picks it up and reopens this path.
const pendingCodeKey = 'frameos.link-frame.code'
const pendingCodeTtlMs = 10 * 60 * 1000

export function stashLinkCode(code: string): void {
  try {
    window.sessionStorage.setItem(pendingCodeKey, JSON.stringify({ at: Date.now(), code }))
  } catch {
    // Storage blocked: the user types the code again after signing in.
  }
}

/** One-shot: the code parked before a re-authentication round trip, if fresh. */
export function takeStashedLinkCode(): string | undefined {
  try {
    const raw = window.sessionStorage.getItem(pendingCodeKey)
    if (!raw) {
      return undefined
    }
    window.sessionStorage.removeItem(pendingCodeKey)
    const parsed = JSON.parse(raw) as { at?: unknown; code?: unknown }
    if (typeof parsed.code === 'string' && typeof parsed.at === 'number' && Date.now() - parsed.at < pendingCodeTtlMs) {
      return parsed.code
    }
  } catch {
    // Fall through: nothing parked.
  }
  return undefined
}

const errorMessages: Record<string, string> = {
  invalid_user_code: 'No frame is waiting with that code. Check the code on the frame — it is 8 characters, dashes optional.',
  login_required: 'Your session expired. Sign in again to link a frame.',
  device_request_approved: 'That code was already approved.',
  device_request_denied: 'That request was cancelled on the frame or denied here; ask the frame for a fresh code.',
  device_request_expired: 'That code expired; ask the frame for a fresh one.',
  expired_token: 'That code expired; ask the frame for a fresh one.',
}

function describeError(code: string | undefined): string {
  if (code && errorMessages[code]) {
    return errorMessages[code]
  }
  return code ? `Could not link the frame (${code}).` : 'Could not link the frame — try again in a moment.'
}

function statusLine(request: DeviceLinkRequest): string {
  switch (request.status) {
    case 'pending':
      return 'Waiting for your approval.'
    case 'approved':
      return 'Approved.'
    case 'denied':
      return 'Denied — ask the frame for a fresh code if that was a mistake.'
    case 'expired':
      return 'Expired — ask the frame for a fresh code.'
  }
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'busy'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'approved' }

export interface LinkRunningFrameFormProps {
  /** A code parked before a re-authentication round trip: looked up at once. */
  initialCode?: string | undefined
  /** Where to go once the linked frame has enrolled. Defaults to the frame's workspace. */
  onLinked?: ((frame: FrameListEntry) => void) | undefined
}

export function LinkRunningFrameForm({ initialCode, onLinked }: LinkRunningFrameFormProps): ReactElement {
  const [code, setCode] = useState(initialCode ?? '')
  const [request, setRequest] = useState<DeviceLinkRequest | undefined>()
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  // The fleet as it was before approving: the frame that appears beyond it
  // is the one this code linked.
  const [knownFrameIds, setKnownFrameIds] = useState<ReadonlySet<string> | null>(null)
  // Monotonic id per lookup so a slow answer cannot overwrite a newer one.
  const lookupSeq = useRef(0)
  const { enrolledFrame, hintDue } = useEnrollmentWatch({ active: phase.kind === 'approved', knownFrameIds })

  const openLinkedFrame = useRef(onLinked)
  openLinkedFrame.current = onLinked
  useEffect(() => {
    if (!enrolledFrame) {
      return
    }
    if (openLinkedFrame.current) {
      openLinkedFrame.current(enrolledFrame)
    } else {
      window.location.assign(cloudFrameUrl(enrolledFrame.id))
    }
  }, [enrolledFrame])

  async function lookup(nextCode = code): Promise<void> {
    const trimmed = nextCode.trim()
    if (!trimmed) {
      setPhase({ kind: 'error', message: 'Type the code the frame shows.' })
      return
    }
    const seq = ++lookupSeq.current
    setPhase({ kind: 'busy', message: 'Finding the frame…' })
    setRequest(undefined)
    let response: Response
    let payload: DeviceLinkRequest | { error?: string }
    try {
      response = await fetch(`/api/device/request?user_code=${encodeURIComponent(trimmed)}`)
      payload = (await response.json().catch(() => ({}))) as DeviceLinkRequest | { error?: string }
    } catch {
      if (seq === lookupSeq.current) {
        setPhase({ kind: 'error', message: describeError(undefined) })
      }
      return
    }
    if (seq !== lookupSeq.current) {
      return
    }
    if (!response.ok) {
      setPhase({ kind: 'error', message: describeError('error' in payload ? payload.error : undefined) })
      return
    }
    setRequest(payload as DeviceLinkRequest)
    setPhase({ kind: 'idle' })
  }

  async function decide(action: 'authorize' | 'deny'): Promise<void> {
    if (!request) {
      return
    }
    setPhase({ kind: 'busy', message: action === 'authorize' ? 'Linking the frame…' : 'Cancelling…' })
    // Snapshot before the approval lands: the frame enrols within seconds of
    // its next poll, and a baseline taken after that would never see it.
    if (action === 'authorize') {
      const frames = await fetchFrameList()
      setKnownFrameIds(new Set((frames ?? []).map((frame) => frame.id)))
    }
    let response: Response
    let payload: { error?: string; status?: string }
    try {
      response = await fetch(`/api/device/${action}`, {
        body: JSON.stringify({ user_code: request.user_code }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      payload = (await response.json().catch(() => ({}))) as { error?: string; status?: string }
    } catch {
      setPhase({ kind: 'error', message: describeError(undefined) })
      return
    }
    if (!response.ok) {
      if (response.status === 403 && payload.error === 'reauth_required') {
        stashLinkCode(request.user_code)
        window.location.assign(`/login/reauth?return_to=${encodeURIComponent(window.location.href)}`)
        return
      }
      setPhase({ kind: 'error', message: describeError(payload.error) })
      return
    }
    if (action === 'authorize') {
      setRequest({ ...request, status: 'approved' })
      setPhase({ kind: 'approved' })
    } else {
      setRequest({ ...request, status: 'denied' })
      setPhase({ kind: 'idle' })
    }
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    void lookup()
  }

  useEffect(() => {
    if (initialCode) {
      void lookup(initialCode)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCode])

  const busy = phase.kind === 'busy'
  const canDecide = request?.status === 'pending' && !busy && phase.kind !== 'approved'

  return (
    <div className="space-y-3">
      <p className="frameos-muted text-xs">
        On the frame, open Settings → FrameOS Cloud → Connect (or read the code off its screen). Type that code here to
        link the frame to this account — the code proves you can see the device.
      </p>
      {phase.kind !== 'approved' ? (
        <form className="flex items-end gap-2" onSubmit={submit}>
          <label className="grid min-w-0 flex-1 gap-1">
            <span className="frameos-muted text-xs font-semibold">Code from the frame</span>
            <input
              aria-label="Code from the frame"
              autoCapitalize="characters"
              autoComplete="off"
              className="frameos-control w-full rounded-lg border px-2.5 py-1.5 font-mono text-sm uppercase tracking-widest focus:border-blue-500 focus:ring-blue-500"
              disabled={busy}
              inputMode="text"
              onChange={(event) => setCode(event.target.value)}
              placeholder="H7LU-JLWN"
              spellCheck={false}
              value={code}
            />
          </label>
          <button
            className="frameos-secondary-button inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={busy}
            type="submit"
          >
            <MagnifyingGlassIcon aria-hidden className="h-4 w-4" />
            Find frame
          </button>
        </form>
      ) : null}

      {phase.kind === 'busy' ? <p className="frameos-muted text-xs">{phase.message}</p> : null}
      {phase.kind === 'error' ? (
        <p className="frameos-warning-button rounded-xl border px-3 py-2 text-xs" role="alert">
          {phase.message}
        </p>
      ) : null}

      {request ? (
        <div className="frameos-inset space-y-2 rounded-xl px-3 py-2 text-xs" data-testid="link-frame-request">
          <div className="flex items-start gap-2">
            <LinkIcon aria-hidden className="frameos-strong mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="frameos-strong truncate text-sm font-semibold">{request.public_display_name}</div>
              <div className="frameos-muted">
                {request.client_kind === 'frame' ? 'A FrameOS frame' : 'A FrameOS backend'}
                {request.local_origin ? ` at ${request.local_origin}` : ''} · code {request.user_code}
              </div>
              <div className="frameos-muted">{statusLine(request)}</div>
            </div>
          </div>
          {canDecide ? (
            <div className="flex flex-wrap gap-2">
              <button
                className="frameos-primary-action inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold text-white transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                onClick={() => void decide('authorize')}
                type="button"
              >
                <CheckCircleIcon aria-hidden className="h-4 w-4" />
                Link this frame
              </button>
              <button
                className="frameos-secondary-button rounded-lg px-3 py-2 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                onClick={() => void decide('deny')}
                type="button"
              >
                Not mine
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {phase.kind === 'approved' ? (
        <div className="frameos-card space-y-2 rounded-xl border px-3 py-2 text-xs" data-testid="link-frame-enrollment">
          {enrolledFrame ? (
            <>
              <p className="frameos-strong flex items-start gap-1.5 text-sm font-semibold">
                <CheckCircleIcon aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" />
                <span>Frame &ldquo;{enrolledFrame.name || request?.public_display_name || 'New frame'}&rdquo; linked.</span>
              </p>
              <a
                className="frameos-primary-action inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold text-white transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                data-testid="link-frame-open"
                href={cloudFrameUrl(enrolledFrame.id)}
              >
                Open frame
                <ArrowRightIcon aria-hidden className="h-4 w-4" />
              </a>
            </>
          ) : (
            <>
              <p className="frameos-muted">
                Approved. The frame picks the approval up on its next check-in and enrols itself — it opens here as soon
                as it does.
              </p>
              {hintDue ? (
                <p className="frameos-muted">
                  Nothing yet — the frame usually shows up within a few seconds of being approved. If its screen still
                  shows the code, check that it can reach the internet; it keeps polling while the code is valid.
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}
