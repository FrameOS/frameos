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
import { SceneWorkspace } from '../../../../frontend/src/scenes/workspace/SceneWorkspace'

interface CloudSceneProps {
  id?: string
  frameId?: string
  sceneId?: string
  nodeId?: string
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

  const { framesLoaded } = useValues(framesModel)

  if (!framesLoaded) {
    return <div>Loading...</div>
  }

  return <>{children}</>
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

export function CloudAppsWorkspace({ frameId, sceneId, nodeId }: CloudSceneProps) {
  return (
    <CloudGate>
      <AppsWorkspace frameId={frameId} sceneId={sceneId} nodeId={nodeId} />
    </CloudGate>
  )
}
