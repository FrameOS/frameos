import type { FrameType } from '../../types'
import { apiFetch } from '../../utils/apiFetch'
import { downloadBlob } from '../../utils/objectUrl'
import { Blake2b512, ReleaseSignatureError, verifyReleaseDigest } from '../../utils/releaseSigning'
import { firmwareDownloadFileName } from './picoFirmware'

// The published release, as a browser flasher reaches it: the listing, the
// merged image for a platform, and that image's signature.
//
// Firmware bytes come from a control plane's release pipe: /api/frames/firmware
// serves the published image so the browser never talks to api.github.com (no
// CORS, 60 req/h per IP). The pipe passes GitHub's bytes through unchanged, so
// the browser checks them against the release's minisign signature
// (`signature=1`, utils/releaseSigning.ts) before esptool writes a byte — and
// it must, on flash.frameos.net (cloud/docs/flasher.md), where the bytes may
// have been handed over by a page the flasher does not know.

const firmwareListingUrl = '/api/frames/firmware'
const releasePlatformByHardware: Record<string, string> = {
  'esp32-s3': 'esp32-s3-generic',
  'esp32-c3': 'esp32-c3-generic',
}

/** The platform string this frame is known by: what the device reported at
 * enrollment (cloud frames) or the configured embedded platform (backend
 * frames, which have no device-reported hardware). */
export function frameHardwarePlatform(frame: FrameType): string {
  return (frame.hardware?.platform ?? frame.embedded?.platform ?? '').toLowerCase()
}

/** Whether a published release asset is known for this frame's platform —
 * the gate for offering the release updater on self-hosted backend frames. */
export function hasReleaseFirmwarePlatform(frame: FrameType): boolean {
  return frameHardwarePlatform(frame) in releasePlatformByHardware
}

/** The generic image for a chip ('esp32-s3' → 'esp32-s3-generic'). */
export function genericReleasePlatform(chipPlatform: string): string {
  return releasePlatformByHardware[chipPlatform.toLowerCase()] ?? 'esp32-s3-generic'
}

export interface ReleaseFirmwareAsset {
  name: string
  platform: string
  size: number
  /** What to do with the file: "bin" is esptool-flashed from the browser,
   * "uf2" is copied onto a Pico's BOOTSEL drive, "img.gz" is an SD image.
   * The self-hosted backend sends it; FrameOS Cloud's listing does not. */
  format?: string
}

export interface ReleaseFirmwareListing {
  assets?: ReleaseFirmwareAsset[]
  release?: string
}

/** Which published asset fits this frame's chip: the generic image, the
 * answer when nothing better is known (see releaseFirmwarePlatformForFrame). */
export function releaseFirmwarePlatform(frame: FrameType): string {
  return releasePlatformByHardware[frameHardwarePlatform(frame)] ?? 'esp32-s3-generic'
}

/** The fallback when the board's own partition table cannot be read: the
 * control plane's answer for this frame — the image built for its configured
 * flash layout (esp32-c3-16mb for a 16MB XTEINK X4, esp32-s3-32mb for a 13.3E6
 * board) when the release publishes one — and the per-chip generic image
 * wherever the provisioning route does not exist (the cloud) or cannot
 * answer. With a readable table the update picks the image by the table
 * itself (layoutPlatformForPartitions), which is the only one it can write. */
export async function releaseFirmwarePlatformForFrame(frame: FrameType): Promise<string> {
  try {
    const response = await apiFetch(`/api/frames/${frame.id}/embedded/provisioning`)
    if (response.ok) {
      const platform = (await response.json())?.provisioning?.releasePlatform
      if (typeof platform === 'string' && platform) {
        return platform
      }
    }
  } catch {
    // The static per-chip answer below is what this flow always used.
  }
  return releaseFirmwarePlatform(frame)
}

/** The published release and its assets — also how the deploy drawer learns
 * "latest is vY" to compare against the device-reported frameos_version.
 * Note `release` keeps its "v" prefix; device versions do not. */
export async function fetchReleaseFirmwareListing(): Promise<ReleaseFirmwareListing> {
  return await planeFirmwareSource().listing()
}

/** One release image, as a flasher is about to write it. */
export interface ReleaseImage {
  bytes: Uint8Array
  name: string
  release: string
  /** False only for a development build a plane serves in place of the
   * release (FRAMEOS_ESP32_GENERIC_FIRMWARE), which no signature covers. */
  signed: boolean
}

/** Where a flash gets the release listing and the image bytes. */
export interface FirmwareSource {
  listing(): Promise<ReleaseFirmwareListing>
  image(platform: string, listing: ReleaseFirmwareListing, log: (message: string) => void): Promise<ReleaseImage>
}

/** `frameos-<version>-<platform>.bin`: the name a release image's signature
 * must have been made for (its trusted comment), built from the release tag
 * and the platform the flasher chose, never read off the download. */
export function releaseImageAssetName(release: string | null | undefined, platform: string): string {
  const version = (release ?? '').replace(/^v/, '')
  if (!/^\d+(\.\d+)*$/.test(version)) {
    throw new ReleaseSignatureError(
      'The firmware download did not say which release it is — refusing to write an unverified image.',
      'signature_unavailable'
    )
  }
  return `frameos-${version}-${platform}.bin`
}

/** Check an image's bytes against its .minisig: signed by the FrameOS
 * release key, AS this release's image for this platform. Throws
 * ReleaseSignatureError. */
export async function verifyReleaseImage(
  bytes: Uint8Array,
  minisig: string,
  release: string | null | undefined,
  platform: string
): Promise<void> {
  const assetName = releaseImageAssetName(release, platform)
  const hasher = new Blake2b512()
  // In pieces, so the hash never needs a second copy of the image.
  for (let offset = 0; offset < bytes.length; offset += 1 << 20) {
    hasher.update(bytes.subarray(offset, offset + (1 << 20)))
  }
  await verifyReleaseDigest(hasher.digest(), minisig, assetName)
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

/**
 * A release pipe over HTTP: a plane's own `/api/frames/firmware`
 * (planeFirmwareSource) or flash.frameos.net's, which is the cloud's.
 *
 * `requireSignature`: a plane's own flasher writes a development image its
 * plane serves in place of the release (409 unsigned_release) after saying
 * so; flash.frameos.net never writes anything unsigned.
 */
export function httpFirmwareSource(
  fetcher: Fetcher,
  { requireSignature, baseUrl = firmwareListingUrl }: { requireSignature: boolean; baseUrl?: string }
): FirmwareSource {
  return {
    async listing() {
      // Never the browser's copy: a backend's listing may be cached for
      // minutes, and a release named by a stale listing is not the one whose
      // image and signature come next.
      const response = await fetcher(baseUrl, { cache: 'no-store' })
      if (!response.ok) {
        throw new Error('Could not look up the latest FrameOS release.')
      }
      return (await response.json()) as ReleaseFirmwareListing
    },
    async image(platform, listing, log) {
      const asset = listing.assets?.find((entry) => entry.platform === platform)
      if (!asset) {
        throw new Error(`Release ${listing.release || '?'} publishes no ${platform} firmware to update to.`)
      }
      log(`Downloading ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)`)
      const query = `?platform=${encodeURIComponent(platform)}`
      const response = await fetcher(`${baseUrl}${query}`, { cache: 'no-store' })
      if (!response.ok) {
        throw new Error('Could not download the firmware image.')
      }
      const bytes = new Uint8Array(await response.arrayBuffer())
      // The release that served these bytes (a plane's release cache can move
      // on between the listing and the download). A plane serves its
      // development build under "local-dev"; nothing signs it.
      const servedRelease = response.headers.get('x-frameos-release')
      const localDev = servedRelease === 'local-dev'
      const release = servedRelease && !localDev ? servedRelease : (listing.release ?? '')
      const signature = await fetcher(`${baseUrl}${query}&signature=1`, { cache: 'no-store' })
      if (signature.status === 409 && localDev && !requireSignature) {
        log(`${asset.name} is a development build with no release signature: writing it unverified.`)
        return { bytes, name: asset.name, release, signed: false }
      }
      if (!signature.ok) {
        throw new ReleaseSignatureError(
          `The release signature could not be fetched (${signature.status}) — refusing to write an unverified image.`,
          'signature_unavailable'
        )
      }
      await verifyReleaseImage(bytes, await signature.text(), release, platform)
      log(`Checked ${asset.name} against the FrameOS release signature.`)
      return { bytes, name: asset.name, release, signed: true }
    },
  }
}

/** The plane this page is served by: its own release pipe, same origin. */
export function planeFirmwareSource(): FirmwareSource {
  return httpFirmwareSource((url, init) => apiFetch(url, init), { requireSignature: false })
}

export async function downloadReleaseFirmware(
  platform: string,
  log: (message: string) => void,
  knownListing?: ReleaseFirmwareListing
): Promise<ReleaseImage> {
  const source = planeFirmwareSource()
  const listing = knownListing ?? (await source.listing())
  return await source.image(platform, listing, log)
}

/**
 * Save a release asset to the person's disk instead of flashing it — the Pico
 * family's .uf2, which no browser can write to the board itself. Same release
 * pipe (and so the same auth and base path) as the flashers above; the
 * backend names the file in its response headers.
 */
export async function saveReleaseFirmwareFile(asset: ReleaseFirmwareAsset): Promise<string> {
  const response = await apiFetch(`${firmwareListingUrl}?platform=${encodeURIComponent(asset.platform)}`, {
    cache: 'no-store',
  })
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? `The latest release does not publish ${asset.name}.`
        : 'Could not download the firmware file.'
    )
  }
  const fileName = firmwareDownloadFileName(response.headers, asset.name)
  downloadBlob(await response.blob(), fileName)
  return fileName
}
