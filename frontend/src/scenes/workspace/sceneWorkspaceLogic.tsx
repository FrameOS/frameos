import { afterMount, kea, key, path, props } from 'kea'
import { frameEditorsLogic } from '../frame/frameEditorsLogic'
import { parseRouteFrameId } from '../../utils/frameId'
import { workspaceLogic } from './workspaceLogic'
import type { sceneWorkspaceLogicType } from './sceneWorkspaceLogicType'

export interface SceneWorkspaceLogicProps {
  routeFrameId?: string | null
  routeSceneId?: string | null
}

export const sceneWorkspaceLogic = kea<sceneWorkspaceLogicType>([
  path(['src', 'scenes', 'workspace', 'sceneWorkspaceLogic']),
  props({} as SceneWorkspaceLogicProps),
  key((props) => `${props.routeFrameId ?? 'none'}:${props.routeSceneId ?? 'none'}`),
  afterMount(({ props }) => {
    const frameId = parseRouteFrameId(props.routeFrameId)
    const sceneId = props.routeSceneId ?? null

    workspaceLogic.actions.setRouteSelection(frameId, sceneId)

    if (frameId && sceneId) {
      frameEditorsLogic({ frameId }).actions.selectScene(sceneId)
    }
  }),
])
