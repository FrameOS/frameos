import { useMountedLogic, useValues } from 'kea'
import type { ReactNode } from 'react'

import { appsModel } from '../../../../frontend/src/models/appsModel'
import { entityImagesModel } from '../../../../frontend/src/models/entityImagesModel'
import { fontsModel } from '../../../../frontend/src/models/fontsModel'
import { framesModel } from '../../../../frontend/src/models/framesModel'
import { templatesModel } from '../../../../frontend/src/models/templatesModel'
import { Frame } from '../../../../frontend/src/scenes/frame/Frame'
import { socketLogic } from '../../../../frontend/src/scenes/socketLogic'
import { AppsWorkspace } from '../../../../frontend/src/scenes/workspace/AppsWorkspace'
import { FramesHome } from '../../../../frontend/src/scenes/workspace/FramesHome'
import { PhotosWorkspace } from '../../../../frontend/src/scenes/photos/PhotosWorkspace'
import { Settings } from '../../../../frontend/src/scenes/settings/Settings'
import { SceneWorkspace } from '../../../../frontend/src/scenes/workspace/SceneWorkspace'

interface CloudSceneProps {
  id?: string
  frameId?: string
  sceneId?: string
  nodeId?: string
  page?: string
}

// There is no explicit session check here: the models load through
// apiFetch, whose cloud branch redirects to the Next.js /login page on the
// first 401 (with return_to back to this route). See
// frontend/src/utils/apiFetch.ts and cloud/docs/cloud-frames.md.
function CloudGate({ children }: { children: ReactNode }) {
  useMountedLogic(socketLogic)
  useMountedLogic(appsModel)
  useMountedLogic(fontsModel)
  useMountedLogic(entityImagesModel)
  useMountedLogic(templatesModel)

  // framesEverLoaded, not framesLoaded: the latter means "has at least one
  // frame", so an account that has not added one yet — every new account —
  // would wait here forever instead of seeing the empty fleet and the Add
  // frame button.
  const { framesEverLoaded } = useValues(framesModel)

  if (!framesEverLoaded) {
    return <div>Loading...</div>
  }

  return <>{children}</>
}

// An account with no frames gets the enrollment panel in the middle of the
// workspace (CloudFirstRunAddFrame, registered in main.tsx as the shared
// frames home's first-run panel), with the rail and the frame tree around
// it like on every other page.
export function CloudFramesHome() {
  return (
    <CloudGate>
      <FramesHome />
    </CloudGate>
  )
}

export function CloudFrame({ id }: CloudSceneProps) {
  return (
    <CloudGate>
      <Frame id={id ?? ''} />
    </CloudGate>
  )
}

export function CloudSceneWorkspace({ frameId, sceneId }: CloudSceneProps) {
  return (
    <CloudGate>
      <SceneWorkspace frameId={frameId} sceneId={sceneId} />
    </CloudGate>
  )
}

export function CloudAppsWorkspace({ frameId, sceneId, nodeId }: CloudSceneProps) {
  return (
    <CloudGate>
      <AppsWorkspace frameId={frameId} sceneId={sceneId} nodeId={nodeId} />
    </CloudGate>
  )
}

export function CloudPhotosWorkspace() {
  return (
    <CloudGate>
      <PhotosWorkspace />
    </CloudGate>
  )
}

// The account pages (frontend/src/scenes/settings/account): the shared
// settings scene draws them in cloud mode, one per /account/<page>.
export function CloudSettings({ page }: CloudSceneProps) {
  return (
    <CloudGate>
      <Settings page={page} />
    </CloudGate>
  )
}
