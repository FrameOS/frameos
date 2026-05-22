import { afterMount, kea, key, path, props } from 'kea'
import { chatLogic } from '../frame/panels/Chat/chatLogic'
import { panelsLogic } from '../frame/panels/panelsLogic'
import type { workspaceChatDrawerLogicType } from './workspaceChatDrawerLogicType'

export interface WorkspaceChatDrawerLogicProps {
  frameId: number
  sceneId?: string | null
}

export const workspaceChatDrawerLogic = kea<workspaceChatDrawerLogicType>([
  path(['src', 'scenes', 'workspace', 'workspaceChatDrawerLogic']),
  props({} as WorkspaceChatDrawerLogicProps),
  key((props) => `${props.frameId}:${props.sceneId ?? 'frame'}`),
  afterMount(({ props }) => {
    const chat = chatLogic({ frameId: props.frameId, sceneId: props.sceneId ?? null }).actions

    if (props.sceneId) {
      panelsLogic({ frameId: props.frameId }).actions.selectScene(props.sceneId)
      chat.ensureChatForScene(props.sceneId)
    } else {
      chat.ensureFrameChat()
    }
  }),
])
