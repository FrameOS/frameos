import { afterMount, kea, key, path, props } from 'kea'
import { AppNodeData } from '../../types'
import { panelsLogic } from '../frame/panels/panelsLogic'
import { workspaceLogic } from './workspaceLogic'

import type { activeAppSelectionLogicType } from './activeAppSelectionLogicType'

export interface ActiveAppSelectionLogicProps {
  frameId: number
  sceneId: string
  nodeId: string
  nodeData: AppNodeData
}

export const activeAppSelectionLogic = kea<activeAppSelectionLogicType>([
  path(['src', 'scenes', 'workspace', 'activeAppSelectionLogic']),
  props({} as ActiveAppSelectionLogicProps),
  key((props) => `${props.frameId}:${props.sceneId}:${props.nodeId}`),
  afterMount(({ props }) => {
    workspaceLogic.actions.setRouteSelection(props.frameId, props.sceneId)
    const panelActions = panelsLogic({ frameId: props.frameId }).actions
    panelActions.selectScene(props.sceneId)
    panelActions.editApp(props.sceneId, props.nodeId, props.nodeData)
  }),
])
