import type { ReactElement } from 'react'

import { claimTokenTtlHours, cloudOrigin } from '../cloudConfig'
import { AddFramePanel } from './AddFramePanel'

// First run: an account with no frames yet.
//
// The frames home renders this in the middle of the workspace when the fleet
// has loaded and is empty (frontend/src/scenes/workspace/FramesHome.tsx,
// through registerFirstRunPanel in main.tsx): the rail with its buttons and
// the frame tree stay around it like on every other page, and the enrollment
// panel is the content instead of a list with nothing in it.
//
// Same component as the drawer placement, no `onClose`: there is nothing
// behind this to close back to. The moment a frame exists — including a
// freshly enrolled one arriving over the fleet websocket — the frames home
// renders the list instead, and the panel goes back to being a drawer.
export function CloudFirstRunAddFrame(): ReactElement {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4 py-8">
      <div className="frameos-panel w-full max-w-2xl overflow-hidden rounded-[24px] border border-white/80 bg-white/95 shadow-2xl shadow-slate-500/25 backdrop-blur-xl">
        <AddFramePanel claimTokenTtlHours={claimTokenTtlHours()} cloudOrigin={cloudOrigin()} />
      </div>
    </div>
  )
}
