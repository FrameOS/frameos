import clsx from 'clsx'
import { useMountedLogic, useValues } from 'kea'
import type { ReactElement } from 'react'

import { authThemeLogic } from '../../../frontend/src/scenes/auth/authThemeLogic'
import { claimTokenTtlHours, cloudOrigin } from '../cloudConfig'
import { AddFramePanel } from './AddFramePanel'

// First run: an account with no frames yet.
//
// The workspace shell around an empty fleet is all chrome and no content — a
// frame tree with nothing in it, a search box with nothing to search, an
// "Add frame" button whose drawer is the only thing worth looking at. So when
// the fleet has loaded and is empty, the whole shell is skipped and the
// enrollment panel becomes the page, centered under the account header.
//
// Same component as the drawer placement, no `onClose`: there is nothing
// behind this to close back to. The moment a frame exists — including a
// freshly enrolled one arriving over the fleet websocket — CloudFramesHome
// renders the normal workspace instead, and the panel goes back to being a
// drawer. Both branches read the same framesModel state, so the swap happens
// live, without a reload.
export function CloudFirstRunAddFrame(): ReactElement {
  // The shell normally owns the theme (it applies data-frameos-theme on mount
  // and paints the page background from it). Nothing else on this page would,
  // so borrow the tiny logic the chrome-less auth screens use.
  useMountedLogic(authThemeLogic)
  const { theme } = useValues(authThemeLogic)

  return (
    <div
      className={clsx(
        'frameos-app-shell h-full overflow-y-auto text-slate-900',
        theme === 'dark' && 'frameos-theme-dark'
      )}
    >
      {/* min-h-full rather than h-full: a tall card grows the box and the
          parent scrolls, instead of centering it and clipping its top. */}
      <div className="flex min-h-full items-center justify-center px-4 py-8">
        <div className="frameos-panel w-full max-w-2xl overflow-hidden rounded-[24px] border border-white/80 bg-white/95 shadow-2xl shadow-slate-500/25 backdrop-blur-xl">
          <AddFramePanel claimTokenTtlHours={claimTokenTtlHours()} cloudOrigin={cloudOrigin()} />
        </div>
      </div>
    </div>
  )
}
