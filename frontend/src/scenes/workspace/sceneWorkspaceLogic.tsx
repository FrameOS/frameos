import { afterMount, kea, key, path, props } from 'kea'
import { frameEditorsLogic } from '../frame/frameEditorsLogic'
import { workspaceLogic } from './workspaceLogic'
import type { sceneWorkspaceLogicType } from './sceneWorkspaceLogicType'

export interface SceneWorkspaceLogicProps {
  routeFrameId?: string | null
  routeSceneId?: string | null
}

function parseFrameId(frameId?: string | null): number | null {
  if (!frameId) {
    return null
  }
  const parsed = parseInt(frameId, 10)
  return Number.isFinite(parsed) ? parsed : null
}

export const sceneWorkspaceLogic = kea<sceneWorkspaceLogicType>([
  path(['src', 'scenes', 'workspace', 'sceneWorkspaceLogic']),
  props({} as SceneWorkspaceLogicProps),
  key((props) => `${props.routeFrameId ?? 'none'}:${props.routeSceneId ?? 'none'}`),
  afterMount(({ props }) => {
    const frameId = parseFrameId(props.routeFrameId)
    const sceneId = props.routeSceneId ?? null

    workspaceLogic.actions.setRouteSelection(frameId, sceneId)

    if (frameId && sceneId) {
      frameEditorsLogic({ frameId }).actions.selectScene(sceneId)
    }
  }),
])
