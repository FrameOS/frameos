import { afterMount, kea, key, path, props } from 'kea'
import { panelsLogic } from '../frame/panels/panelsLogic'
import { workspaceLogic } from './workspaceLogic'

import type { appsWorkspaceLogicType } from './appsWorkspaceLogicType'

export interface AppsWorkspaceLogicProps {
  routeFrameId?: string | null
  routeSceneId?: string | null
  routeNodeId?: string | null
}

function parseFrameId(frameId?: string | null): number | null {
  if (!frameId) {
    return null
  }
  const parsed = parseInt(frameId, 10)
  return Number.isFinite(parsed) ? parsed : null
}

export const appsWorkspaceLogic = kea<appsWorkspaceLogicType>([
  path(['src', 'scenes', 'workspace', 'appsWorkspaceLogic']),
  props({} as AppsWorkspaceLogicProps),
  key((props) => `${props.routeFrameId ?? 'none'}:${props.routeSceneId ?? 'none'}:${props.routeNodeId ?? 'none'}`),
  afterMount(({ props }) => {
    const frameId = parseFrameId(props.routeFrameId)
    const sceneId = props.routeSceneId ?? null

    workspaceLogic.actions.setRouteSelection(frameId, sceneId)

    if (frameId && sceneId) {
      panelsLogic({ frameId }).actions.selectScene(sceneId)
    }
  }),
])
