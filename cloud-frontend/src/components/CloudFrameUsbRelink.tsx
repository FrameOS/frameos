import { ArrowPathIcon } from '@heroicons/react/24/outline'
import { useActions, useValues } from 'kea'
import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'

import {
  embeddedUsbLogStreamSessionPort,
  prepareSerialPortReconnect,
  startEmbeddedUsbLogStream,
  stopEmbeddedUsbLogStream,
  waitForEmbeddedUsbApiIdle,
} from '../../../frontend/src/models/embeddedUsbLogsModel'
import { embeddedUsbConnectLogic } from '../../../frontend/src/scenes/workspace/embeddedUsbConnectLogic'
import type { FrameType } from '../../../frontend/src/types'
import { cloudOrigin } from '../cloudConfig'
import { Esp32CloudFlasher, type Esp32CloudFlasherPortHandoff } from './Esp32CloudFlasher'

export const usbRedeployLabel = 'Redeploy to this board'

/**
 * "Redeploy to this board" in a cloud ESP32 frame's Over USB view: flashes
 * the whole image, NVS included, with a claim token bound to this frame, so a
 * blank or erased board comes back as this frame instead of a new one.
 *
 * Registered into the shared drawer through addFramePanelRegistry; frontend/
 * must never import this bundle.
 */
export function CloudFrameUsbRelink({ frame }: { frame: FrameType }): ReactElement {
  const logic = embeddedUsbConnectLogic({ frameId: frame.id, frame })
  const { identityKnown, identity } = useValues(logic)
  const { setFlasherBusy, recheck } = useActions(logic)
  const [open, setOpen] = useState(false)

  // The connect card sends people here when the board it read is not this
  // frame (blank, other firmware, another frame's). Open then, so the next
  // step is on screen instead of behind a toggle at the bottom.
  const boardNeedsRedeploy = identityKnown && identity !== null && identity.kind !== 'this-frame'
  useEffect(() => {
    if (boardNeedsRedeploy) {
      setOpen(true)
    }
  }, [boardNeedsRedeploy])

  // Same handoff as the shared flashers (EmbeddedReleaseFlasher): take the
  // port from the log stream that holds it, wait out a USB command still in
  // flight, and give the port back to the stream when the flash is over. The
  // connect card is told the flasher owns the port, or it reads the stream
  // stopping as an unplug and resets its session.
  const portHandoff: Esp32CloudFlasherPortHandoff = {
    takeHeldPort: async () => {
      if (!embeddedUsbLogStreamSessionPort(frame.id)) {
        return null
      }
      setFlasherBusy(true)
      let port = await stopEmbeddedUsbLogStream(frame.id)
      if (port) {
        await prepareSerialPortReconnect(port)
      }
      await waitForEmbeddedUsbApiIdle(frame.id)
      if (embeddedUsbLogStreamSessionPort(frame.id)) {
        port = (await stopEmbeddedUsbLogStream(frame.id)) ?? port
      }
      return port
    },
    release: async (port) => {
      let streaming = false
      try {
        if (port) {
          streaming = await startEmbeddedUsbLogStream(frame.id, port as SerialPort)
        }
      } finally {
        setFlasherBusy(false)
      }
      if (streaming) {
        // Read the board again, so the card above says it is this frame now.
        recheck()
      }
    },
  }

  return (
    <section className="space-y-2">
      <div className="frame-tool-card space-y-3 rounded-[22px] p-4">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="frameos-secondary-button inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        >
          <ArrowPathIcon aria-hidden className="h-4 w-4" />
          {open ? 'Hide redeploy' : usbRedeployLabel}
        </button>
        {open ? (
          <>
            <div className="frame-tool-muted text-sm leading-5">
              For a board that is blank, runs other firmware, or was erased and no longer knows it is this frame. This
              flashes FrameOS and links the board to{' '}
              <span className="font-semibold text-[color:var(--tool-strong)]">{frame.name || 'this frame'}</span>. Its
              scenes, assets and logs stay. You need to enter the Wi-Fi details again.
            </div>
            <Esp32CloudFlasher
              cloudOrigin={cloudOrigin()}
              reenrollFrame={{ id: String(frame.id), name: frame.name || 'this frame' }}
              portHandoff={portHandoff}
            />
          </>
        ) : (
          <div className="frame-tool-muted text-xs leading-4">
            Use this when the board is blank or a factory reset cut its link to this frame.
          </div>
        )}
      </div>
    </section>
  )
}
