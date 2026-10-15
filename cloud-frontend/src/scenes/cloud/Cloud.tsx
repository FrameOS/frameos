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
import { CloudHome } from '../../../../frontend/src/scenes/home/CloudHome'
import { PublicStoreFront } from '../../../../frontend/src/scenes/store/PublicStoreFront'
import { cloudSignedIn } from '../../../../frontend/src/utils/cloudMode'
import { urls } from '../../../../frontend/src/urls'
import { accountNavUrls } from '../../cloudConfig'
import { PhotosWorkspace } from '../../../../frontend/src/scenes/photos/PhotosWorkspace'
import { Settings } from '../../../../frontend/src/scenes/settings/Settings'
import { SceneWorkspace } from '../../../../frontend/src/scenes/workspace/SceneWorkspace'

interface CloudSceneProps {
  id?: string
  frameId?: string
  sceneId?: string
  nodeId?: string
  keyword?: string
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
// The scene store's front: signed out it is the public store without the
// workspace around it; signed in it is the scenes library (on the account
// origin — the scenes host's root may be a different host).
export function CloudStoreFront() {
  if (cloudSignedIn()) {
    const target = new URL(urls.scenesHome('store'), accountNavUrls().framesUrl)
    target.search = typeof window !== 'undefined' ? window.location.search : ''
    if (typeof window !== 'undefined') {
      window.location.replace(target.toString())
    }
    return <div className="p-6 text-slate-500">Opening the scene library...</div>
  }
  return <PublicStoreFront />
}

// The home page behind the rail's logo: hello, the recent frames and
// albums, the account's usage (frontend/src/scenes/home/CloudHome.tsx).
export function CloudHomePage() {
  return (
    <CloudGate>
      <CloudHome />
    </CloudGate>
  )
}

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

export function CloudAppsWorkspace({ frameId, sceneId, nodeId, keyword }: CloudSceneProps) {
  return (
    <CloudGate>
      <AppsWorkspace frameId={frameId} sceneId={sceneId} nodeId={nodeId} keyword={keyword} />
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
