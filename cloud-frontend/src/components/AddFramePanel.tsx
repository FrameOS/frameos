import {
  ArrowLeftIcon,
  ArrowPathIcon,
  ChevronRightIcon,
  ClipboardDocumentIcon,
  CommandLineIcon,
  CpuChipIcon,
  DevicePhoneMobileIcon,
  QrCodeIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'

import { Esp32CloudFlasher } from './Esp32CloudFlasher'
import { SdImageBuilder } from './SdImageBuilder'

// Known error codes from POST /api/frames/claim-tokens. "Could not prepare the
// enrollment" plus a raw code told the user nothing, and the old hint ("check
// whether you hit the frame limit") was actively wrong for a claim-code quota.
//
// Unused single-use codes are recycled automatically at the cap, so reaching
// this one means the cap is full of multi-use SD-image codes — which are held
// deliberately, because a flashed card may still be waiting to enrol.
const mintErrorMessages: Record<string, string> = {
  claim_token_quota_exceeded:
    'Every outstanding claim code belongs to an SD-card image, so none can be recycled. Enrol or expire one of those images before adding another frame.',
  frame_quota_exceeded: 'You have reached your frame limit — remove a frame before adding another.',
  login_required: 'Your session expired. Sign in again to add a frame.',
}

// "Add frame": four enrollment paths (install script, SD image, link code,
// ESP32 USB flashing), presented in two stages — first a chooser with one
// line per path, then the chosen path's full form. Claim codes are plumbing,
// not UX: the install command is minted once per opening (see the mint site
// below for why that is safe now), so it is ready to copy the moment the
// script path is opened. The SD builder and the ESP32 flasher mint their own
// — multi-use and single-use respectively — on first use, because those
// flows can take minutes and burn a code per attempt. The server stores only
// hashes; every enrolled frame appears as pending until the owner confirms
// it.
//
// Ported from cloud/apps/auth-web/src/components/AddFramePanel.tsx, which owned
// the only copy of this flow while /account/frames and /frames both showed
// frames. This component is deliberately free of kea and of the router: the
// workspace drawer around it (CloudAddFrameDrawer) owns "is it open", so the
// panel can be unit-tested with plain React Testing Library.
export interface AddFramePanelProps {
  // The TTL is deployment-configurable (FRAMEOS_CLOUD_CLAIM_TOKEN_TTL_HOURS),
  // so hardcoding 24 here would quietly lie on any tuned install. It reaches
  // the browser through the shell config the /frames route injects.
  claimTokenTtlHours: number
  // The origin frames enrol against. NOT window.location.origin: this value is
  // baked into SD images, ESP32 NVS and install commands, so it has to be the
  // deployment's real public URL rather than whatever host the admin happens to
  // be browsing through (a tunnel, a LAN IP, 127.0.0.1 vs localhost). The
  // server computes it with getAccountBaseUrl() and injects it into the shell.
  cloudOrigin: string
  // Omitted by the first-run screen, where the panel IS the page and there is
  // nothing behind it to close back to. One component, two placements.
  onClose?: (() => void) | undefined
}

type AddFramePath = 'script' | 'sd' | 'link' | 'esp32' | 'reenroll'

// The frames listing rows the reconnect path needs — GET /api/frames serves
// the full summary; only these fields are read here.
interface ReenrollFrameChoice {
  id: string
  name: string
  panel?: string
  connected?: boolean
}

// Stage one: one button per enrollment path, each with a single line saying
// what it is for. The chosen path's full form is stage two.
const pathChoices: {
  description: string
  icon: typeof CommandLineIcon
  key: AddFramePath
  title: string
}[] = [
  {
    description: 'Run one command on a device that already runs Linux — it installs FrameOS and links the frame here.',
    icon: CommandLineIcon,
    key: 'script',
    title: 'Install script (any Pi / most Linux)',
  },
  {
    description: 'Build a personalized image in this browser, flash it to a card, and the Pi enrolls on first boot.',
    icon: DevicePhoneMobileIcon,
    key: 'sd',
    title: 'SD card image (Raspberry Pi)',
  },
  {
    description: 'Already have FrameOS on your network? Approve the short code the frame shows to link it here.',
    icon: QrCodeIcon,
    key: 'link',
    title: 'Link a frame that already runs',
  },
  {
    description: 'Plug the board in over USB — this browser writes the firmware and enrolls the frame automatically.',
    icon: CpuChipIcon,
    key: 'esp32',
    title: 'Flash an ESP32 from this browser',
  },
  {
    description:
      'An ESP32 that was factory-reset or re-flashed: write the firmware and link it back to a frame you already have — its scenes, assets and logs carry over.',
    icon: ArrowPathIcon,
    key: 'reenroll',
    title: 'Reconnect a board to an existing frame',
  },
]

export function AddFramePanel({ claimTokenTtlHours, cloudOrigin, onClose }: AddFramePanelProps): ReactElement {
  // undefined = the chooser stage; a key = that path's form.
  const [path, setPath] = useState<AddFramePath | undefined>()
  const [claimToken, setClaimToken] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [installCopied, setInstallCopied] = useState(false)
  // Multi-use token for the SD image builder: one personalized image can be
  // flashed to many cards, each boot enrolling a distinct frame. Minted once
  // per panel session, on the first build.
  const [multiUseToken, setMultiUseToken] = useState<string | undefined>()
  const [multiUseExpiresAt, setMultiUseExpiresAt] = useState<string | undefined>()
  // The cached multi-use token is only reusable for the validity it was
  // minted with; changing the validity in the SD builder mints a fresh one.
  const [multiUseTtlDays, setMultiUseTtlDays] = useState<number | 'forever' | undefined>()
  const [minting, setMinting] = useState(false)
  // The reconnect path: which existing esp32 frames the board could be linked
  // back to. Fetched once per panel session, on first entering the path.
  const [reenrollFrames, setReenrollFrames] = useState<ReenrollFrameChoice[] | undefined>()
  const [reenrollError, setReenrollError] = useState<string | undefined>()
  const [reenrollTarget, setReenrollTarget] = useState<ReenrollFrameChoice | undefined>()
  const abortRef = useRef<AbortController | undefined>(undefined)
  const cancelledRef = useRef(false)
  // One mint per opening, whatever React does with renders. A ref, not state:
  // it must survive a re-render and a strict-mode double mount without
  // triggering either.
  const mintStartedRef = useRef(false)

  const origin = cloudOrigin
  // Downloaded to a file and then run — NOT `curl … | sudo sh`.
  //
  // The installer asks questions (display, timezone, admin password). Piping
  // into `sudo sh` makes sudo's stdin a pipe, and on distributions that default
  // to `Defaults use_pty` (Ubuntu among them) sudo then does not relay the
  // terminal into the pty it created. The script's read from /dev/tty blocks
  // forever: keystrokes echo on the real terminal and reach nobody, so the
  // install looks frozen with no way out but Ctrl-C.
  //
  // Running a file keeps stdin on the terminal, so the prompts work. It is
  // also the honest shape: the script is on disk before anything executes it.
  //
  // No FRAMEOS_CLOUD_URL: /install.sh is served with this provider's origin
  // already stamped in (app/install.sh/route.ts), so the URL appears once and
  // the two copies can never disagree.
  const installCommandFor = (token: string): string =>
    `curl -fsSL ${origin}/install.sh -o /tmp/frameos-install.sh && ` +
    `sudo FRAMEOS_CLAIM_TOKEN=${token} sh /tmp/frameos-install.sh`
  const installCommand = claimToken ? installCommandFor(claimToken) : undefined
  // Shown before a code exists, so the command is not a mystery: same shape,
  // with the code itself masked until it is minted.
  const maskedInstallCommand = installCommandFor('<claim code>')

  // The panel is mounted only while it is on screen — the drawer renders it
  // when "Add frame" is clicked, the first-run screen when the fleet is empty
  // — so mounting IS opening, and that is when the code is minted.
  //
  // Closing unmounts, which discards the single-use code (an install may
  // already have spent it) and cancels a mint still in flight, so a slow
  // response can never land on top of a newer token.
  useEffect(() => {
    cancelledRef.current = false
    if (!mintStartedRef.current) {
      mintStartedRef.current = true
      void mintInstallCode()
    }
    return () => {
      cancelledRef.current = true
      abortRef.current?.abort()
      abortRef.current = undefined
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Minted when the panel opens, so the install command is copyable on sight
  // rather than one click away.
  //
  // This deliberately reverses the earlier lazy-minting rule, and the reason
  // that rule existed is gone: codes are stored only as hashes and nothing can
  // revoke one, so every open used to spend a slot of
  // FRAMEOS_CLOUD_MAX_CLAIM_TOKENS_PER_ACCOUNT (50) permanently, and a user
  // browsing in and out of the panel could lock themselves out for a full TTL.
  // The server now recycles instead of refusing: at the cap it deletes the
  // oldest never-used SINGLE-USE codes (evictOldestUnusedClaimTokens in
  // cloud/apps/auth-web/src/lib/frames.ts) — which is exactly the kind this
  // mints — so repeat opens churn one slot instead of consuming many.
  //
  // Eager minting therefore DEPENDS on that recycling. Remove or narrow it and
  // this has to go back to being lazy, or opening the panel a few dozen times
  // locks the account out of enrollment for a day.
  //
  // (Under React StrictMode the double mount's cleanup would abort this single
  // request and the guard above would not re-issue it; the bundle does not
  // enable StrictMode, and spending a second code to cover a dev-only remount
  // is the worse trade.)
  async function mintInstallCode(): Promise<void> {
    if (claimToken || minting) {
      return
    }
    setMinting(true)
    setError(undefined)
    const controller = new AbortController()
    abortRef.current?.abort()
    abortRef.current = controller
    try {
      const response = await fetch('/api/frames/claim-tokens', {
        body: JSON.stringify({}),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        signal: controller.signal,
      })
      const data = (await response.json().catch(() => ({}))) as {
        claim_token?: string
        error?: string
      }
      if (controller.signal.aborted || cancelledRef.current) {
        return
      }
      if (!response.ok || !data.claim_token) {
        setError(data.error ?? 'claim_token_failed')
        return
      }
      setClaimToken(data.claim_token)
    } catch {
      if (!controller.signal.aborted && !cancelledRef.current) {
        setError('network_error')
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = undefined
      }
      setMinting(false)
    }
  }

  // Re-enrollment binds a claim token to an EXISTING frame, so the path needs
  // the fleet list to pick from. Only esp32 frames qualify: they are the only
  // hardware whose identity lives in flashable NVS.
  useEffect(() => {
    if (path !== 'reenroll' || reenrollFrames !== undefined) {
      return
    }
    let cancelled = false
    setReenrollError(undefined)
    void (async () => {
      try {
        const response = await fetch('/api/frames')
        const data = (await response.json().catch(() => ({}))) as {
          frames?: {
            id?: string
            name?: string
            hardware?: { platform?: string; panel?: string }
            connected?: boolean
          }[]
        }
        if (cancelled) {
          return
        }
        if (!response.ok || !Array.isArray(data.frames)) {
          setReenrollError('Could not load your frames — try again in a moment.')
          return
        }
        setReenrollFrames(
          data.frames
            .filter((frame) => (frame.hardware?.platform ?? '').toLowerCase().startsWith('esp32'))
            .map((frame) => ({
              id: String(frame.id),
              name: frame.name || 'Unnamed frame',
              panel: frame.hardware?.panel,
              connected: frame.connected,
            }))
        )
      } catch {
        if (!cancelled) {
          setReenrollError('Could not load your frames — try again in a moment.')
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [path, reenrollFrames])

  async function copyText(text: string, setFlag: (value: boolean) => void): Promise<void> {
    await navigator.clipboard.writeText(text)
    setFlag(true)
    setTimeout(() => setFlag(false), 2000)
  }

  // Passed to SdImageBuilder; the multi_use flag is forwarded to the claim
  // token endpoint so one token covers many enrollments, and ttlDays picks
  // how long the code accepts new frames (the endpoint's ttl_days).
  async function mintClaimToken({
    multiUse,
    ttlDays,
  }: {
    multiUse: boolean
    ttlDays?: number | 'forever'
  }): Promise<string> {
    if (multiUse && multiUseToken && ttlDays === multiUseTtlDays) {
      return multiUseToken
    }
    const response = await fetch('/api/frames/claim-tokens', {
      body: JSON.stringify(multiUse ? { multi_use: true, ...(ttlDays ? { ttl_days: ttlDays } : {}) } : {}),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    const data = (await response.json()) as {
      claim_token?: string
      error?: string
      expires_at?: string
    }
    if (!response.ok || !data.claim_token) {
      throw new Error(data.error ?? 'claim_token_failed')
    }
    if (multiUse) {
      setMultiUseToken(data.claim_token)
      setMultiUseExpiresAt(data.expires_at)
      setMultiUseTtlDays(ttlDays)
    }
    return data.claim_token
  }

  return (
    <div className="flex h-full flex-col">
      <div className="frameos-divider flex items-start justify-between gap-3 border-b border-slate-200/80 px-5 py-4">
        <div className="min-w-0">
          <h2 className="frameos-strong truncate text-xl font-bold tracking-normal">Add a frame</h2>
          <div className="frameos-muted text-xs">
            Pick whichever path fits your hardware. New frames show up here as <em>pending</em> until you confirm them.
          </div>
        </div>
        {onClose ? (
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="frameos-icon-button flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            <XMarkIcon className="h-6 w-6" />
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {error ? (
          <p className="frameos-warning-button rounded-xl border px-3 py-2 text-xs" role="alert">
            {mintErrorMessages[error] ?? `Could not prepare the enrollment (${error}) — try again in a moment.`}
          </p>
        ) : null}

        {path === undefined ? (
          <div className="grid gap-2">
            {pathChoices.map((choice) => (
              <button
                key={choice.key}
                className="frameos-card flex items-center gap-3 rounded-2xl border border-white/90 p-4 text-left shadow-sm transition hover:border-blue-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                onClick={() => setPath(choice.key)}
                type="button"
              >
                <choice.icon aria-hidden className="frameos-strong h-6 w-6 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="frameos-strong block text-sm font-semibold">{choice.title}</span>
                  <span className="frameos-muted block text-xs">{choice.description}</span>
                </span>
                <ChevronRightIcon aria-hidden className="frameos-muted h-5 w-5 shrink-0" />
              </button>
            ))}
          </div>
        ) : (
          <button
            className="frameos-muted inline-flex items-center gap-1.5 text-xs font-semibold transition hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            onClick={() => setPath(undefined)}
            type="button"
          >
            <ArrowLeftIcon aria-hidden className="h-4 w-4" />
            All ways to add a frame
          </button>
        )}

        {path === 'script' ? (
          <section className="frameos-card rounded-2xl border border-white/90 p-4 shadow-sm">
            <h3 className="frameos-strong mb-1 flex items-center gap-2 text-sm font-semibold">
              <CommandLineIcon aria-hidden className="h-5 w-5" />
              Install script (any Pi / most Linux)
            </h3>
            <p className="frameos-muted text-xs">
              Already running Raspberry Pi OS — or Debian/Ubuntu on any Pi or other Linux box? Run this on the device;
              it installs FrameOS, asks a few questions about your display, and links the frame here:
            </p>
            <pre className="frameos-inset mt-2 overflow-x-auto rounded-xl px-3 py-2 text-[11px] leading-relaxed [user-select:all]">
              {installCommand ?? maskedInstallCommand}
            </pre>
            {/* Same shape in every state — masked command, one button, one line
              of explanation — so the code arriving does not shift the layout
              under a cursor that is already on its way to Copy. */}
            <button
              className="frameos-secondary-button mt-2 inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!installCommand}
              onClick={() => (installCommand ? void copyText(installCommand, setInstallCopied) : undefined)}
              type="button"
            >
              <ClipboardDocumentIcon aria-hidden className="h-4 w-4" />
              {installCopied ? 'Copied' : 'Copy command'}
            </button>
            <p className="frameos-muted mt-2 text-xs">
              {minting
                ? 'Creating a single-use claim code…'
                : installCommand
                ? `The claim code above is single-use and expires within ${claimTokenTtlHours} hours.`
                : `Claim codes are single-use and expire within ${claimTokenTtlHours} hours.`}
            </p>
          </section>
        ) : null}

        {path === 'sd' ? (
          <section className="frameos-card rounded-2xl border border-white/90 p-4 shadow-sm">
            <h3 className="frameos-strong mb-1 flex items-center gap-2 text-sm font-semibold">
              <DevicePhoneMobileIcon aria-hidden className="h-5 w-5" />
              SD card image (Raspberry Pi)
            </h3>
            <SdImageBuilder
              claimToken={multiUseToken}
              claimTokenExpiresAt={multiUseExpiresAt}
              cloudOrigin={cloudOrigin}
              mintClaimToken={mintClaimToken}
            />
          </section>
        ) : null}

        {path === 'link' ? (
          <section className="frameos-card rounded-2xl border border-white/90 p-4 shadow-sm">
            <h3 className="frameos-strong mb-1 flex items-center gap-2 text-sm font-semibold">
              <QrCodeIcon aria-hidden className="h-5 w-5" />
              Link a frame that already runs
            </h3>
            <p className="frameos-muted text-xs">
              Already have FrameOS running and on your network? Open its admin page (Settings → FrameOS Cloud →
              Connect). The frame shows a short code; type it on the{' '}
              <a className="frameos-link underline" href="/device">
                device page
              </a>{' '}
              to approve it.
            </p>
            <p className="frameos-muted mt-2 text-xs">
              The frame asks and you approve — nothing to copy from here, and the code proves you can see the device.
            </p>
          </section>
        ) : null}

        {path === 'esp32' ? (
          <section className="frameos-card rounded-2xl border border-white/90 p-4 shadow-sm">
            <h3 className="frameos-strong mb-1 flex items-center gap-2 text-sm font-semibold">
              <CpuChipIcon aria-hidden className="h-5 w-5" />
              Flash an ESP32 from this browser
            </h3>
            <Esp32CloudFlasher cloudOrigin={cloudOrigin} />
          </section>
        ) : null}

        {path === 'reenroll' ? (
          <section className="frameos-card rounded-2xl border border-white/90 p-4 shadow-sm">
            <h3 className="frameos-strong mb-1 flex items-center gap-2 text-sm font-semibold">
              <ArrowPathIcon aria-hidden className="h-5 w-5" />
              Reconnect a board to an existing frame
            </h3>
            <p className="frameos-muted text-xs">
              For a board whose settings were wiped — a factory reset, or a full flash. Pick the frame it should come
              back as: flashing writes the firmware and links the board to that frame, keeping its scenes, assets and
              logs. Wi-Fi has to be entered again.
            </p>
            {reenrollError ? (
              <p className="frameos-warning-button mt-2 rounded-xl border px-3 py-2 text-xs" role="alert">
                {reenrollError}
              </p>
            ) : reenrollFrames === undefined ? (
              <p className="frameos-muted mt-2 text-xs">Loading your frames…</p>
            ) : reenrollFrames.length === 0 ? (
              <p className="frameos-muted mt-2 text-xs">
                This account has no ESP32 frames to reconnect to. Use “Flash an ESP32 from this browser” to enroll the
                board as a new frame instead.
              </p>
            ) : (
              <div className="mt-2 grid gap-2">
                {reenrollFrames.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    aria-pressed={reenrollTarget?.id === candidate.id}
                    onClick={() => setReenrollTarget(candidate)}
                    className={`flex items-center gap-3 rounded-2xl border p-3 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${
                      reenrollTarget?.id === candidate.id
                        ? 'border-blue-400 bg-blue-50/60'
                        : 'frameos-card border-white/90 hover:border-blue-400'
                    }`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="frameos-strong block text-sm font-semibold">{candidate.name}</span>
                      <span className="frameos-muted block text-xs">
                        {candidate.panel ?? 'esp32'}
                        {/* Offline is the expected state of the board being repaired;
                          a frame that is ONLINE is probably not the one you mean. */}
                        {candidate.connected ? ' · currently online' : ' · offline'}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            {reenrollTarget ? (
              // Keyed so switching targets restarts the flasher with a claim
              // token bound to the newly chosen frame.
              <div className="mt-3">
                <Esp32CloudFlasher
                  key={reenrollTarget.id}
                  cloudOrigin={cloudOrigin}
                  reenrollFrame={{ id: reenrollTarget.id, name: reenrollTarget.name }}
                />
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
    </div>
  )
}
