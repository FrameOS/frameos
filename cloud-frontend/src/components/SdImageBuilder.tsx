import { ArrowDownTrayIcon, CircleStackIcon } from '@heroicons/react/24/outline'
import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'

import { renderCloudConfig, sanitizeConfigValue, SdImagePatchError, patchCloudConfig } from '../lib/sd-image-patch'
import { fetchReleaseListing } from '../lib/release-lookup'
import { clearRememberedWifi, loadRememberedWifi, storeRememberedWifi } from '../lib/remembered-wifi'

// "Download SD image" for cloud-managed Raspberry Pi frames
// (docs/cloud-frames.md, "Placeholder + in-browser personalization"): the
// browser fetches the GENERIC .img.gz release asset, stream-decompresses it,
// and rewrites the 4096-byte frameos-cloud.txt placeholder on the boot
// partition with this cloud's URL, a multi-use claim code, and (optionally)
// WiFi credentials — entirely client-side, so credentials never reach the
// server. If the release image has no placeholder the UI says so instead of
// shipping a card that will never enrol.
//
// Ported from cloud/apps/auth-web/src/components/SdImageBuilder.tsx so the
// whole add-frame flow lives in one place (the /frames workspace). The only
// changes are cosmetic (Tailwind + the workspace's own control classes) plus
// the two hydration workarounds this bundle no longer needs — see below.

// Server-side, session-gated and cached release lookup. The browser used to
// call api.github.com directly, which burns the unauthenticated 60 req/hr/IP
// budget — a single corporate NAT is enough to turn that into a 403 for
// everyone behind it.
const firmwareApiUrl = '/api/frames/firmware'

const knownBoards = [
  { label: 'Raspberry Pi Zero 2 W', platform: 'raspberry-pi-zero-2-w' },
  { label: 'Raspberry Pi Zero W', platform: 'raspberry-pi-zero-w' },
] as const

// The curated display list mirrors the install script's menu
// (scripts/frameos-setup.sh, choose_device). The release image ships every
// compiled driver, so this choice is written into the image's frameos-cloud.txt
// and applied on first boot — "custom" accepts any device key the frame
// understands. Empty device = decide later in the on-device setup portal.
const displayChoices = [
  { label: 'Pick the display later (FrameOS-Setup portal)', value: '' },
  { height: 480, label: 'Web preview only (no display)', value: 'web_only', width: 800 },
  { label: 'HDMI / Linux framebuffer', value: 'framebuffer' },
  { height: 480, label: 'HTTP upload (POST rendered PNG)', value: 'http.upload', width: 800 },
  { height: 480, label: 'Pimoroni Inky Impression 7.3" (2025)', value: 'pimoroni.inky_impression_7_2025', width: 800 },
  {
    height: 1200,
    label: 'Pimoroni Inky Impression 13.3" (2025)',
    value: 'pimoroni.inky_impression_13_2025',
    width: 1600,
  },
  { height: 480, label: 'Waveshare 7.3" E (Spectra 6)', value: 'waveshare.EPD_7in3e', width: 800 },
  { height: 1200, label: 'Waveshare 13.3" E (Spectra 6)', value: 'waveshare.EPD_13in3e', width: 1600 },
  { height: 480, label: 'Waveshare 7.5" V2 (black/white)', value: 'waveshare.EPD_7in5_V2', width: 800 },
  { height: 480, label: 'Waveshare PhotoPainter (7.3" E)', value: 'waveshare.rpi_zero_photopainter_7in3e', width: 800 },
  { label: 'Custom device key…', value: 'custom' },
] as const

const rotationChoices = ['0', '90', '180', '270'] as const

// How long the multi-use claim code embedded in the image accepts new frames.
// Expiry only gates NEW enrollments — frames already confirmed stay connected.
// 'forever' mints a code that never expires (every enrollment still needs
// owner confirmation, and the frame quota bounds a leaked image).
const claimValidityChoices = [
  { label: '1 day', value: '1' },
  { label: '1 week', value: '7' },
  { label: '3 months (default)', value: '90' },
  { label: '1 year', value: '365' },
  { label: 'Forever', value: 'forever' },
] as const
const defaultClaimValidity = '90'

// "Remember WiFi" is shared with the ESP32 flasher — one stored network for
// the whole add-frame panel (../lib/remembered-wifi).

interface FirmwareAsset {
  name: string
  platform: string
  size: number
}

interface Board {
  asset?: FirmwareAsset | undefined
  label: string
  platform: string
}

type ReleaseState =
  | { status: 'loading' }
  | { message: string; status: 'error' }
  | { boards: Board[]; status: 'ready'; version: string }

type BuildPhase = 'idle' | 'building' | 'done' | 'error'

// File System Access API (Chrome/Edge); not yet in lib.dom.
interface WritableImageStream {
  abort(): Promise<void>
  close(): Promise<void>
  write(data: Uint8Array): Promise<void>
}

type SaveFilePicker = (options: {
  suggestedName?: string
  types?: { accept: Record<string, string[]>; description?: string }[]
}) => Promise<{ createWritable(): Promise<WritableImageStream> }>

async function* streamChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array, void, undefined> {
  const reader = stream.getReader()
  let drained = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        drained = true
        return
      }
      if (value && value.length > 0) {
        yield value
      }
    }
  } finally {
    // Whoever consumes this may bail out early (a patch error, a failed disk
    // write). Releasing the lock alone would leave a multi-hundred-MB
    // download running in the background, so cancel the source too.
    if (!drained) {
      await reader.cancel().catch(() => undefined)
    }
    reader.releaseLock()
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

const controlClassName =
  'frameos-control block w-full rounded-lg border px-2.5 py-1.5 text-sm focus:border-blue-500 focus:ring-blue-500 disabled:opacity-50'

export function SdImageBuilder({
  claimToken,
  claimTokenExpiresAt,
  cloudOrigin,
  mintClaimToken,
}: {
  claimToken?: string | undefined
  claimTokenExpiresAt?: string | undefined
  // Written into the image's frameos-cloud.txt, so it must be the
  // deployment's public URL rather than whatever host the admin happens to be
  // browsing through (a tunnel, a LAN IP, 127.0.0.1 vs localhost). The panel
  // above resolves it from the shell config the server injects.
  cloudOrigin: string
  mintClaimToken: (opts: { multiUse: boolean; ttlDays?: number | 'forever' }) => Promise<string>
}): ReactElement {
  const [release, setRelease] = useState<ReleaseState>({ status: 'loading' })
  const [platform, setPlatform] = useState('')
  const [frameName, setFrameName] = useState('')
  const remembered = useRef(loadRememberedWifi()).current
  const [wifiSsid, setWifiSsid] = useState(remembered?.ssid ?? '')
  const [wifiPassword, setWifiPassword] = useState(remembered?.password ?? '')
  const [rememberWifi, setRememberWifi] = useState(remembered !== undefined)
  const [displayChoice, setDisplayChoice] = useState<string>('')
  const [customDevice, setCustomDevice] = useState('')
  const [width, setWidth] = useState('')
  const [height, setHeight] = useState('')
  const [rotate, setRotate] = useState('0')
  const [vcom, setVcom] = useState('')
  const [uploadUrl, setUploadUrl] = useState('')
  const [claimValidity, setClaimValidity] = useState<string>(defaultClaimValidity)
  const [phase, setPhase] = useState<BuildPhase>('idle')
  const [status, setStatus] = useState('')
  const [progressBytes, setProgressBytes] = useState(0)
  const [error, setError] = useState<string | undefined>()
  const busyRef = useRef(false)

  const origin = cloudOrigin
  // In the Next.js version these two were decided in an effect after mount:
  // read during render they made the server emit one branch and the hydrating
  // client another, which is a hydration error. This bundle is client-only
  // with no SSR, so the capability check can happen on the first render — but
  // it stays a lazy state initializer rather than a bare expression, because
  // capabilities cannot change for the lifetime of the page and re-probing on
  // every render would be pure noise.
  const [supported] = useState(
    () => typeof DecompressionStream !== 'undefined' && typeof ReadableStream !== 'undefined'
  )
  const [canStreamToDisk] = useState(() => typeof window !== 'undefined' && 'showSaveFilePicker' in window)

  useEffect(() => {
    let cancelled = false
    async function loadRelease(): Promise<void> {
      try {
        const data = await fetchReleaseListing<{
          assets?: FirmwareAsset[]
          release?: string
        }>(firmwareApiUrl)
        if (cancelled) {
          return
        }
        // The route lists ESP32 firmware alongside the SD images, so match on
        // the board's platform and prefer an .img.gz; a board with no entry
        // stays listed but disabled.
        const boards: Board[] = knownBoards.map((board) => {
          const candidates = (data.assets ?? []).filter((asset) => asset.platform === board.platform)
          return {
            asset: candidates.find((asset) => asset.name?.endsWith('.img.gz')) ?? candidates[0],
            label: board.label,
            platform: board.platform,
          }
        })
        setRelease({
          boards,
          status: 'ready',
          // The route sends "" when the release carries no tag.
          version: data.release || 'latest',
        })
        const firstAvailable = boards.find((board) => board.asset)
        if (firstAvailable) {
          setPlatform((current) => current || firstAvailable.platform)
        }
      } catch (loadError) {
        if (!cancelled) {
          setRelease({
            message: loadError instanceof Error ? loadError.message : String(loadError),
            status: 'error',
          })
        }
      }
    }
    void loadRelease()
    return () => {
      cancelled = true
    }
  }, [])

  function failWith(message: string): void {
    setError(message)
    setPhase('error')
  }

  const device = displayChoice === 'custom' ? customDevice.trim() : displayChoice
  const showCustomDevice = displayChoice === 'custom'
  // vcom only matters for panels whose driver reads it (IT8951-style, e.g.
  // waveshare.EPD_10in3) — none of the curated list does, so it only shows
  // for custom keys instead of cluttering every Waveshare pick.
  const showVcom = displayChoice === 'custom'
  const showUploadUrl = displayChoice === 'custom' || device === 'http.upload'
  const showDisplayDetails = displayChoice !== ''

  function pickDisplay(value: string): void {
    setDisplayChoice(value)
    const choice = displayChoices.find((entry) => entry.value === value)
    // Prefill the panel's native dimensions; clear them when they are
    // unknown (framebuffer autodetects, custom is anyone's guess).
    setWidth(choice && 'width' in choice && choice.width ? String(choice.width) : '')
    setHeight(choice && 'height' in choice && choice.height ? String(choice.height) : '')
  }

  // Returns an error message, or undefined when the display inputs are sane.
  // Validated before the save dialog opens: a half-built image is worse than
  // refusing up front.
  function displayInputError(): string | undefined {
    if (!showDisplayDetails) {
      return undefined
    }
    if (showCustomDevice && !device) {
      return 'Enter the custom device key (e.g. waveshare.EPD_2in13_V4).'
    }
    for (const [value, label] of [
      [width, 'Display width'],
      [height, 'Display height'],
    ] as const) {
      if (value && !/^[1-9][0-9]{0,4}$/.test(value)) {
        return `${label} must be a whole number of pixels.`
      }
    }
    if (vcom && !/^-?[0-9]+(\.[0-9]+)?$/.test(vcom)) {
      return 'VCOM must be a number like -1.48 (printed on the panel’s flex cable).'
    }
    if (device === 'http.upload' && !uploadUrl.trim()) {
      return 'HTTP upload needs the URL to POST rendered images to.'
    }
    return undefined
  }

  async function build(): Promise<void> {
    if (busyRef.current || release.status !== 'ready') {
      return
    }
    const board = release.boards.find((entry) => entry.platform === platform)
    if (!board?.asset) {
      setError('Pick a board with a published image first.')
      setPhase('error')
      return
    }
    busyRef.current = true
    setError(undefined)
    setProgressBytes(0)
    setPhase('building')
    let writable: WritableImageStream | undefined
    try {
      // Validate user input before opening the save dialog.
      sanitizeConfigValue(frameName, 'Frame name')
      sanitizeConfigValue(wifiSsid, 'WiFi network name')
      sanitizeConfigValue(wifiPassword, 'WiFi password')
      sanitizeConfigValue(device, 'Display device')
      sanitizeConfigValue(uploadUrl.trim(), 'Upload URL')
      const displayError = displayInputError()
      if (displayError) {
        failWith(displayError)
        busyRef.current = false
        return
      }
      if (rememberWifi && wifiSsid) {
        storeRememberedWifi(wifiSsid, wifiPassword)
      } else {
        clearRememberedWifi()
      }

      // Gzipped output: Raspberry Pi Imager and balenaEtcher both read
      // .img.gz directly, it downloads ~10x smaller, and browsers don't flag
      // an archive as a dangerous file the way they do a bare .img.
      const suggestedName = `frameos-${board.platform}-${slugify(frameName) || 'cloud'}.img.gz`
      // Ask for the save location first, while the click's user activation is
      // still fresh (Chrome/Edge; other browsers fall back to a Blob).
      if (canStreamToDisk) {
        const picker = (window as unknown as { showSaveFilePicker: SaveFilePicker }).showSaveFilePicker
        try {
          const handle = await picker({
            suggestedName,
            types: [
              {
                accept: { 'application/gzip': ['.img.gz', '.gz'] },
                description: 'Compressed disk image',
              },
            ],
          })
          writable = await handle.createWritable()
        } catch (pickerError) {
          if (pickerError instanceof DOMException && pickerError.name === 'AbortError') {
            setPhase('idle')
            return
          }
          throw pickerError
        }
      }

      let token = claimToken
      if (!token) {
        setStatus('Creating a multi-use claim code…')
        token = await mintClaimToken({
          multiUse: true,
          ttlDays: claimValidity === 'forever' ? 'forever' : Number(claimValidity),
        })
      }
      const configBytes = renderCloudConfig({
        claimToken: token,
        cloudUrl: origin,
        device: device || undefined,
        height: device && height ? Number(height) : undefined,
        name: frameName,
        rotate: device ? Number(rotate) : undefined,
        uploadUrl: device && showUploadUrl ? uploadUrl.trim() || undefined : undefined,
        vcom: device && showVcom ? vcom || undefined : undefined,
        width: device && width ? Number(width) : undefined,
        wifiPassword: wifiSsid ? wifiPassword : '',
        wifiSsid,
      })

      setStatus(`Downloading ${board.asset.name}…`)
      // Same-origin: GitHub's release redirect sends no CORS headers, so the
      // bytes stream through the provider (see app/api/frames/sd-image).
      const response = await fetch(`/api/frames/sd-image?platform=${encodeURIComponent(board.platform)}`)
      if (!response.ok || !response.body) {
        const detail = (await response.json().catch(() => ({}))) as { error?: string }
        throw new Error(
          detail.error === 'image_not_published'
            ? 'No image published for this board in the latest release yet.'
            : `Image download failed (${detail.error ?? response.status})`
        )
      }
      const decompressed = response.body.pipeThrough(new DecompressionStream('gzip'))

      setStatus('Personalizing and compressing the image…')
      // Re-gzip the patched stream so what lands on disk is a compressed
      // image: smaller, and flashers read it directly.
      const recompressed = new CompressionStream('gzip')
      const recompressedWriter = recompressed.writable.getWriter()
      const blobParts: Uint8Array[] = []
      let written = 0
      let lastShown = 0

      const drain = (async () => {
        for await (const chunk of streamChunks(recompressed.readable)) {
          if (writable) {
            await writable.write(chunk)
          } else {
            blobParts.push(chunk)
          }
        }
      })()
      // The drain side is the one that touches the disk, so it is where a
      // full volume shows up mid-image. Once it dies nobody reads
      // recompressed.readable any more and the loop below would block
      // forever on gzip backpressure — the UI would sit at "Personalizing…"
      // with busyRef stuck true. So race every write against a promise that
      // only ever rejects. The no-op catches keep the same rejection from
      // being reported a second time as unhandled.
      const drainFailure = drain.then(
        () => new Promise<never>(() => undefined),
        (reason: unknown) => Promise.reject(reason)
      )
      drainFailure.catch(() => undefined)
      // A write/close the race abandons still rejects later (we abort the
      // writer), so give it a handler of its own before racing it.
      const raceDrain = (pending: Promise<void>): Promise<void> => {
        pending.catch(() => undefined)
        return Promise.race([pending, drainFailure])
      }

      try {
        for await (const chunk of patchCloudConfig(streamChunks(decompressed), configBytes)) {
          await raceDrain(recompressedWriter.write(chunk as BufferSource))
          written += chunk.length
          if (written - lastShown >= 8 * 1024 * 1024) {
            lastShown = written
            setProgressBytes(written)
          }
        }
        await raceDrain(recompressedWriter.close())
      } catch (pipelineError) {
        // Tear the gzip pipeline down: aborting the writer errors the
        // readable side, which unblocks (and cancels) the drain and the
        // download reader behind it, so `drain` always settles from here.
        await recompressedWriter.abort(pipelineError).catch(() => undefined)
        // Report the drain's reason when it has one: a failed disk write
        // cancels the gzip stream, and the "operation was aborted" that the
        // in-flight write then reports would hide the actual cause.
        throw await drain.then(
          () => pipelineError,
          (reason: unknown) => reason
        )
      }
      await drain
      setProgressBytes(written)
      if (writable) {
        await writable.close()
        writable = undefined
      } else {
        const blob = new Blob(blobParts as BlobPart[], {
          type: 'application/gzip',
        })
        blobParts.length = 0
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = suggestedName
        anchor.click()
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
      }
      setPhase('done')
    } catch (buildError) {
      if (writable) {
        try {
          await writable.abort()
        } catch {
          // Best effort — the partial file is discarded either way.
        }
      }
      if (
        buildError instanceof SdImagePatchError &&
        (buildError.code === 'marker_not_found' ||
          buildError.code === 'placeholder_invalid' ||
          buildError.code === 'truncated_image')
      ) {
        failWith(
          'This release image predates in-browser personalization — update to a newer FrameOS release, or use the install-script flow instead.'
        )
      } else {
        // Always land on a real message: a DOMException from a failed disk
        // write can carry an empty one, and a blank error would look like a
        // silent hang.
        const message = buildError instanceof Error ? buildError.message : String(buildError)
        failWith(message || 'The image could not be written — check the destination has room and try again.')
      }
    } finally {
      busyRef.current = false
    }
  }

  const building = phase === 'building'
  const progressMb = (progressBytes / 1024 / 1024).toFixed(0)

  if (!supported) {
    return (
      <p className="frameos-muted text-xs">
        This browser can&apos;t build the image locally (it needs DecompressionStream — use Chrome, Edge, Firefox or
        Safari 16.4+).
      </p>
    )
  }

  return (
    <div className="space-y-2">
      <p className="frameos-muted text-xs">
        Build a ready-to-flash image for your board right here: it embeds this cloud&apos;s address and a multi-use
        claim code. WiFi credentials are written into the image in your browser — they are never sent to FrameOS Cloud.
      </p>
      {release.status === 'loading' ? (
        <p className="frameos-muted text-xs">Looking up the latest FrameOS release…</p>
      ) : null}
      {release.status === 'error' ? (
        <p className="frameos-warning-button rounded-xl border px-3 py-2 text-xs" role="alert">
          {release.message}
        </p>
      ) : null}
      {release.status === 'ready' ? (
        <div className="grid gap-2">
          <select
            aria-label="Board"
            className={controlClassName}
            disabled={building}
            onChange={(event) => setPlatform(event.target.value)}
            value={platform}
          >
            <option disabled value="">
              Pick a board…
            </option>
            {release.boards.map((board) => (
              <option disabled={!board.asset} key={board.platform} value={board.platform}>
                {board.asset ? `${board.label} (${release.version})` : `${board.label} — image not published yet`}
              </option>
            ))}
          </select>
          <input
            aria-label="Frame name (optional)"
            className={controlClassName}
            disabled={building}
            maxLength={256}
            onChange={(event) => setFrameName(event.target.value)}
            placeholder="Frame name (optional)"
            value={frameName}
          />
          <select
            aria-label="Display"
            className={controlClassName}
            disabled={building}
            onChange={(event) => pickDisplay(event.target.value)}
            value={displayChoice}
          >
            {displayChoices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
          {showCustomDevice ? (
            <input
              aria-label="Custom device key"
              className={controlClassName}
              disabled={building}
              maxLength={128}
              onChange={(event) => setCustomDevice(event.target.value)}
              placeholder="Device key (e.g. waveshare.EPD_2in13_V4)"
              value={customDevice}
            />
          ) : null}
          {showDisplayDetails ? (
            <div className="grid grid-cols-3 gap-2">
              <input
                aria-label="Display width"
                className={controlClassName}
                disabled={building}
                inputMode="numeric"
                maxLength={5}
                onChange={(event) => setWidth(event.target.value)}
                placeholder="Width"
                value={width}
              />
              <input
                aria-label="Display height"
                className={controlClassName}
                disabled={building}
                inputMode="numeric"
                maxLength={5}
                onChange={(event) => setHeight(event.target.value)}
                placeholder="Height"
                value={height}
              />
              <select
                aria-label="Rotation"
                className={controlClassName}
                disabled={building}
                onChange={(event) => setRotate(event.target.value)}
                value={rotate}
              >
                {rotationChoices.map((value) => (
                  <option key={value} value={value}>
                    Rotate {value}°
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {showDisplayDetails && showVcom ? (
            <input
              aria-label="VCOM (optional)"
              className={controlClassName}
              disabled={building}
              maxLength={12}
              onChange={(event) => setVcom(event.target.value)}
              placeholder="VCOM (optional — e.g. -1.48, printed on the panel's flex cable)"
              value={vcom}
            />
          ) : null}
          {showDisplayDetails && showUploadUrl ? (
            <input
              aria-label="Upload URL"
              className={controlClassName}
              disabled={building}
              maxLength={512}
              onChange={(event) => setUploadUrl(event.target.value)}
              placeholder={device === 'http.upload' ? 'Upload URL (required)' : 'Upload URL (optional)'}
              value={uploadUrl}
            />
          ) : null}
          <input
            aria-label="WiFi network name (optional)"
            className={controlClassName}
            disabled={building}
            maxLength={64}
            onChange={(event) => setWifiSsid(event.target.value)}
            placeholder="WiFi network (optional — the FrameOS-Setup portal works too)"
            value={wifiSsid}
          />
          <input
            aria-label="WiFi password"
            className={controlClassName}
            disabled={building || !wifiSsid}
            maxLength={128}
            onChange={(event) => setWifiPassword(event.target.value)}
            placeholder="WiFi password"
            type="password"
            value={wifiPassword}
          />
          <label className="frameos-muted flex items-center gap-2 text-xs">
            <input
              checked={rememberWifi}
              disabled={building}
              onChange={(event) => {
                setRememberWifi(event.target.checked)
                if (!event.target.checked) {
                  clearRememberedWifi()
                }
              }}
              type="checkbox"
            />
            Remember WiFi credentials in this browser (never sent to the cloud)
          </label>
          <label className="frameos-muted flex items-center justify-between gap-2 text-xs">
            <span>Claim code accepts new frames for</span>
            <select
              aria-label="Claim code validity"
              className={`${controlClassName} w-auto`}
              disabled={building}
              onChange={(event) => setClaimValidity(event.target.value)}
              value={claimValidity}
            >
              {claimValidityChoices.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
          {!canStreamToDisk ? (
            <p className="frameos-muted flex items-start gap-1.5 text-xs">
              <CircleStackIcon aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                This browser can&apos;t stream straight to disk, so the whole image (~1–2 GB) is assembled in memory
                before the download starts.
              </span>
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="frameos-primary-action inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold text-white transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={building || !platform}
              onClick={() => void build()}
              type="button"
            >
              <ArrowDownTrayIcon aria-hidden className="h-4 w-4" />
              {building ? (progressBytes > 0 ? `Writing… ${progressMb} MB` : 'Preparing…') : 'Download SD image'}
            </button>
            {building ? (
              <span className="frameos-muted text-xs" role="status">
                {status}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
      {phase === 'done' ? (
        <div className="frameos-success-button rounded-xl border px-3 py-2 text-xs" data-testid="sd-image-done">
          Image saved. Flash this <code>.img.gz</code> to as many SD cards as you like (Raspberry Pi Imager or
          balenaEtcher, &ldquo;Use custom image&rdquo; — both read it compressed). Each frame appears in this workspace
          as <em>pending</em> when it first boots — confirm each one.
          {claimTokenExpiresAt
            ? // A "forever" code carries a 100-year expiry; presenting the
              // year 2126 as a deadline would only confuse.
              new Date(claimTokenExpiresAt).getTime() - Date.now() > 50 * 365 * 24 * 60 * 60 * 1000
              ? ' The embedded claim code never expires — every new frame still needs your confirmation here.'
              : ` The embedded claim code accepts new frames until ${new Date(
                  claimTokenExpiresAt
                ).toLocaleString()} — frames added before then stay connected. After that, build a fresh image here to add more.`
            : ''}
        </div>
      ) : null}
      {error ? (
        <p className="frameos-warning-button rounded-xl border px-3 py-2 text-xs" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
