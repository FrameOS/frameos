import { afterMount, kea, key, path, props } from 'kea'
import { chatLogic } from '../frame/panels/Chat/chatLogic'
import { frameEditorsLogic } from '../frame/frameEditorsLogic'
import type { workspaceChatDrawerLogicType } from './workspaceChatDrawerLogicType'
import type { FrameId } from '../../types'

export interface WorkspaceChatDrawerLogicProps {
  frameId: FrameId
  nodeId?: string | null
  sceneId?: string | null
}

export const workspaceChatDrawerLogic = kea<workspaceChatDrawerLogicType>([
  path(['src', 'scenes', 'workspace', 'workspaceChatDrawerLogic']),
  props({} as WorkspaceChatDrawerLogicProps),
  key((props) => `${props.frameId}:${props.sceneId ?? 'frame'}:${props.nodeId ?? 'scene'}`),
  afterMount(({ props }) => {
    const chat = chatLogic({ frameId: props.frameId, sceneId: props.sceneId ?? null }).actions

    if (props.sceneId && props.nodeId) {
      frameEditorsLogic({ frameId: props.frameId }).actions.selectScene(props.sceneId)
      chat.ensureChatForApp(props.sceneId, props.nodeId)
    } else if (props.sceneId) {
      frameEditorsLogic({ frameId: props.frameId }).actions.selectScene(props.sceneId)
      chat.ensureChatForScene(props.sceneId)
    } else {
      chat.ensureFrameChat()
    }
  }),
])
