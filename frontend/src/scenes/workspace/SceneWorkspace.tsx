import { useMountedLogic, useValues } from 'kea'
import { parseRouteFrameId } from '../../utils/frameId'
import { FrameosShell } from './FrameosShell'
import { SceneEditorPage } from './SceneEditorPage'
import { sceneWorkspaceLogic } from './sceneWorkspaceLogic'
import { ScenesLibraryPage, ScenesSidePanel } from '../store/ScenesLibrary'
import { scenesLibraryLogic } from '../store/scenesLibraryLogic'

interface SceneWorkspaceProps {
  frameId?: string
  sceneId?: string
}

// The scenes page without a frame: the library (the store, the private
// scenes; ?page= names which, the store by default).
function ScenesHome(): JSX.Element {
  const { page } = useValues(scenesLibraryLogic)
  return (
    <FrameosShell
      mode="scenes"
      title="Scenes"
      showAiButton={false}
      tree={<ScenesSidePanel activePage={page}>{null}</ScenesSidePanel>}
    >
      <ScenesLibraryPage />
    </FrameosShell>
  )
}

// /scenes/:frameId(/:sceneId) is a frame's scene editor, full screen
// (SceneEditorPage); /scenes alone the library.
export function SceneWorkspace({ frameId, sceneId }: SceneWorkspaceProps): JSX.Element {
  useMountedLogic(sceneWorkspaceLogic({ routeFrameId: frameId ?? null, routeSceneId: sceneId ?? null }))
  const routeFrameId = parseRouteFrameId(frameId)

  if (routeFrameId !== null) {
    return <SceneEditorPage frameId={routeFrameId} />
  }

  return <ScenesHome />
}

export default SceneWorkspace
