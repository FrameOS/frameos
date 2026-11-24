import type { FirmwareSource, ReleaseFirmwareListing } from '../../../frontend/src/scenes/workspace/releaseFirmware'
import { verifyReleaseImage } from '../../../frontend/src/scenes/workspace/releaseFirmware'
import {
  bridgeMessage,
  parseFrameSetupDocument,
  readOpenerMessage,
  type FlasherJob,
  type FlasherPhase,
  type FlasherToOpener,
  type OpenerToFlasher,
} from '../../../frontend/src/utils/flasherBridge'
import { ReleaseSignatureError } from '../../../frontend/src/utils/releaseSigning'

// flash.frameos.net's half of the bridge (frontend/src/utils/flasherBridge.ts):
// say hello to the page that opened this window, take the first job it sends,
// and from then on hear nothing but that window, at that origin. The job
// arrives as data and is read like a dropped file (parseFrameSetupDocument);
// nothing runs until the person clicks.

const REQUEST_TIMEOUT_MS = 120000

export interface BridgeConnection {
  /** The origin of the page that sent the job: what the flasher shows. */
  origin: string
  job: FlasherJob
  listing: () => Promise<ReleaseFirmwareListing>
  image: (platform: string) => Promise<Extract<OpenerToFlasher, { type: 'image' }>>
  send: (message: FlasherToOpener) => void
  status: (phase: FlasherPhase, message: string | null, progress: number | null) => void
}

/**
 * Wait for a job from `window.opener`. Calls `onJob` with each job it sends
 * (a reload of its page sends it again), `onProblem` with what was refused.
 * Returns the function that stops listening.
 */
export function listenForBridgeJob(
  onJob: (connection: BridgeConnection) => void,
  onProblem: (message: string) => void
): () => void {
  const opener = window.opener as Window | null
  if (!opener) {
    onProblem(
      'This window was not opened by a FrameOS page, so it has nothing to set up. Open it from the frame’s USB card, or drop a setup file below.'
    )
    return () => undefined
  }
  let pinnedOrigin: string | null = null
  let nextId = 1
  const pending = new Map<number, { resolve: (message: OpenerToFlasher) => void; reject: (error: Error) => void }>()

  const send = (message: FlasherToOpener): void => {
    // Before a job: a hello with nothing in it, to whoever opened us. After:
    // only to the origin the job came from.
    opener.postMessage(bridgeMessage(message), pinnedOrigin ?? '*')
  }

  const request = (message: FlasherToOpener & { id: number }): Promise<OpenerToFlasher> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(message.id)
        reject(new Error('The page that opened this window did not answer. Is its tab still open?'))
      }, REQUEST_TIMEOUT_MS)
      pending.set(message.id, {
        resolve: (answer) => {
          clearTimeout(timer)
          resolve(answer)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      send(message)
    })

  const onMessage = (event: MessageEvent): void => {
    if (event.source !== opener) {
      return
    }
    if (pinnedOrigin !== null && event.origin !== pinnedOrigin) {
      return
    }
    const message = readOpenerMessage(event.data)
    if (!message) {
      return
    }
    if (message.type === 'job') {
      let job: FlasherJob
      try {
        job = {
          kind: message.job.kind === 'update' || message.job.kind === 'provision' ? message.job.kind : 'setup',
          setup: parseFrameSetupDocument(message.job.setup),
          pushScenes: message.job.pushScenes === true,
          withWifi: message.job.withWifi === true,
        }
      } catch (error) {
        onProblem(error instanceof Error ? error.message : String(error))
        return
      }
      pinnedOrigin = event.origin
      onJob(connection(event.origin, job))
      return
    }
    const waiting = pending.get(message.id)
    if (!waiting) {
      return
    }
    pending.delete(message.id)
    if (message.type === 'error') {
      waiting.reject(new Error(message.message))
    } else {
      waiting.resolve(message)
    }
  }

  const connection = (origin: string, job: FlasherJob): BridgeConnection => ({
    origin,
    job,
    send,
    status: (phase, message, progress) => send({ type: 'status', phase, message, progress }),
    listing: async () => {
      const answer = await request({ type: 'listing-request', id: nextId++ })
      if (answer.type !== 'listing') {
        throw new Error('The page sent something other than the release listing.')
      }
      return answer.listing
    },
    image: async (platform) => {
      const answer = await request({ type: 'image-request', id: nextId++, platform })
      if (answer.type !== 'image') {
        throw new Error('The page sent something other than the firmware image.')
      }
      return answer
    },
  })

  window.addEventListener('message', onMessage)
  send({ type: 'ready' })
  return () => {
    window.removeEventListener('message', onMessage)
    for (const waiting of pending.values()) {
      waiting.reject(new Error('Stopped.'))
    }
    pending.clear()
  }
}

/**
 * The release as the page that opened the flasher has it — its plane's own
 * pipe, so a self-hosted backend's flash costs FrameOS nothing and writes the
 * release that backend expects. Written only when the FrameOS release
 * signature says these are the bytes of that release's image for that
 * board: an unsigned development build is refused here (its own plane's
 * flasher writes it, on a secure page).
 */
export function bridgeFirmwareSource(connection: BridgeConnection): FirmwareSource {
  return {
    listing: () => connection.listing(),
    async image(platform, listing, log) {
      const asset = listing.assets?.find((entry) => entry.platform === platform)
      if (!asset) {
        throw new Error(`Release ${listing.release || '?'} publishes no ${platform} firmware.`)
      }
      log(`Downloading ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB) through ${connection.origin}`)
      const answer = await connection.image(platform)
      if (!answer.minisig) {
        throw new ReleaseSignatureError(
          `${connection.origin} serves ${asset.name} with no FrameOS release signature (a development build?). ` +
            'This flasher only writes signed FrameOS releases.',
          'signature_unavailable'
        )
      }
      const bytes = new Uint8Array(answer.bytes)
      // The release the page's plane served these bytes from, which its
      // release cache may have moved to since the listing.
      const release = /^v?\d+(\.\d+)*$/.test(answer.release) ? answer.release : (listing.release ?? '')
      await verifyReleaseImage(bytes, answer.minisig, release, platform)
      log(`Checked ${asset.name} against the FrameOS release signature.`)
      return { bytes, name: asset.name, release, signed: true }
    },
  }
}
