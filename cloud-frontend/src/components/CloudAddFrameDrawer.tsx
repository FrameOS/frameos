import { useActions } from 'kea'
import type { ReactElement } from 'react'

import { newFrameForm } from '../../../frontend/src/scenes/frames/newFrameForm'
import { claimTokenTtlHours, cloudOrigin } from '../cloudConfig'
import { AddFramePanel } from './AddFramePanel'

// The workspace drawer that hosts the cloud enrollment panel. FramesHome
// renders it through the registry in
// frontend/src/scenes/workspace/addFramePanelRegistry.ts — frontend/ must not
// import cloud-frontend/ (the same sources build the self-hosted backend and
// the on-device admin bundles), so the cloud bundle hands its panel down
// instead.
//
// "Is it open" stays where the shared shell already keeps it: newFrameForm's
// formVisible, the same reducer the self-hosted "Add frame" form uses. That
// keeps one notion of an open right panel, so opening a scene tile or the
// template drawer still closes this one.
export function CloudAddFrameDrawer(): ReactElement {
  const { hideForm } = useActions(newFrameForm)

  return (
    <div className="workspace-drawer frameos-drawer fixed bottom-5 right-5 top-5 z-40 w-[430px] max-w-[calc(100vw-2.5rem)] overflow-hidden rounded-[24px] border border-white/80 bg-white/95 shadow-2xl shadow-slate-500/30 backdrop-blur-xl">
      <AddFramePanel claimTokenTtlHours={claimTokenTtlHours()} cloudOrigin={cloudOrigin()} onClose={hideForm} />
    </div>
  )
}
