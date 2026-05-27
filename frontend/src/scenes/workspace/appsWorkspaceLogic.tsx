import { afterMount, kea, key, path, props } from 'kea'
import { panelsLogic } from '../frame/panels/panelsLogic'
import { workspaceLogic } from './workspaceLogic'

import type { appsWorkspaceLogicType } from './appsWorkspaceLogicType'

export const SYSTEM_APPS_ROUTE_TOKEN = 'system'

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

function currentAppsHref(): string | null {
  if (typeof window === 'undefined') {
    return null
  }
  return `${window.location.pathname}${window.location.search}`
}

export const appsWorkspaceLogic = kea<appsWorkspaceLogicType>([
  path(['src', 'scenes', 'workspace', 'appsWorkspaceLogic']),
  props({} as AppsWorkspaceLogicProps),
  key((props) => `${props.routeFrameId ?? 'none'}:${props.routeSceneId ?? 'none'}:${props.routeNodeId ?? 'none'}`),
  afterMount(({ props }) => {
    const href = currentAppsHref()
    if (href) {
      workspaceLogic.actions.rememberAppsHref(href)
    }

    if (props.routeFrameId === SYSTEM_APPS_ROUTE_TOKEN) {
      return
    }

    const frameId = parseFrameId(props.routeFrameId)
    const sceneId = props.routeSceneId ?? null

    workspaceLogic.actions.setRouteSelection(frameId, sceneId)

    if (frameId && sceneId) {
      panelsLogic({ frameId }).actions.selectScene(sceneId)
    }
  }),
])
