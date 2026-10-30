import { useActions } from 'kea'
import { CpuChipIcon } from '@heroicons/react/24/outline'

import type { FrameType } from '../../types'
import { frameHasOwningBackend, frameOwningBackendHost, handBackConsoleCommands } from '../../utils/frameOwningBackend'
import { workspaceLogic } from './workspaceLogic'
import { workspaceMode } from './workspaceSurfaces'

/**
 * A cloud frame with a self-hosted backend set on it (a bench setup, `set
 * backend` on its console) turns down every scene, settings and schedule push
 * from the cloud (`backend_managed`, docs/cloud-frames.md "While managed").
 * Says so, and how to hand the frame back: the USB card's "Hand back to the
 * cloud", or the same commands typed into its console. Renders nothing outside
 * the cloud or while the frame reports no backend.
 */
export function CloudBackendOwnerBanner({ frame }: { frame: FrameType }) {
  const { openFrameChangeDrawer } = useActions(workspaceLogic)
  if (workspaceMode() !== 'cloud' || !frameHasOwningBackend(frame)) {
    return null
  }
  const host = frameOwningBackendHost(frame)
  return (
    <div
      data-cloud-backend-owner={frame.id}
      className="frameos-blank-frame-scene-hint mb-4 space-y-2 rounded-lg border border-amber-200 bg-amber-100 px-4 py-3 text-sm font-medium leading-5 text-amber-950 shadow-sm"
    >
      <p>
        A self-hosted backend{host ? ` at ${host}` : ''} controls this frame, so it turns down the scenes and settings
        sent from here.
      </p>
      <p className="font-normal">
        To hand it back, connect the frame over USB and choose Hand back to the cloud, or run these in its console:
      </p>
      <pre className="overflow-x-auto rounded bg-amber-50 px-3 py-2 font-mono text-xs font-normal text-amber-950">
        {handBackConsoleCommands.join('\n')}
      </pre>
      <p className="font-normal">When it reconnects, it gets the scenes, settings and schedule saved here.</p>
      <button
        type="button"
        onClick={() => openFrameChangeDrawer(frame.id, 'deploy', 'cloudUsb')}
        className="frameos-primary-action inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold text-white transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
      >
        <CpuChipIcon aria-hidden className="h-4 w-4" />
        Connect over USB
      </button>
    </div>
  )
}
