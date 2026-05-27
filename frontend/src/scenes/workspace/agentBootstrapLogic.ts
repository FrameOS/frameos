import { actions, kea, key, listeners, path, props, reducers } from 'kea'
import copy from 'copy-to-clipboard'

import { framesModel } from '../../models/framesModel'
import { apiFetch } from '../../utils/apiFetch'

import type { agentBootstrapLogicType } from './agentBootstrapLogicType'

export interface AgentBootstrapLogicProps {
  frameId: number
}

interface AgentBootstrapApiResponse {
  command: string
  script_url: string
}

export const agentBootstrapLogic = kea<agentBootstrapLogicType>([
  path(['src', 'scenes', 'workspace', 'agentBootstrapLogic']),
  props({} as AgentBootstrapLogicProps),
  key((props) => props.frameId),
  actions({
    copyAgentBootstrapScript: (selectAgent = true) => ({ selectAgent }),
    copyAgentBootstrapScriptSuccess: true,
    copyAgentBootstrapScriptFailure: (error: string) => ({ error }),
    resetAgentBootstrapScriptState: true,
  }),
  reducers({
    loading: [
      false,
      {
        copyAgentBootstrapScript: () => true,
        copyAgentBootstrapScriptSuccess: () => false,
        copyAgentBootstrapScriptFailure: () => false,
      },
    ],
    copied: [
      false,
      {
        copyAgentBootstrapScript: () => false,
        copyAgentBootstrapScriptSuccess: () => true,
        copyAgentBootstrapScriptFailure: () => false,
        resetAgentBootstrapScriptState: () => false,
      },
    ],
    error: [
      null as string | null,
      {
        copyAgentBootstrapScript: () => null,
        copyAgentBootstrapScriptSuccess: () => null,
        copyAgentBootstrapScriptFailure: (_, { error }) => error,
        resetAgentBootstrapScriptState: () => null,
      },
    ],
  }),
  listeners(({ actions, props }) => ({
    copyAgentBootstrapScript: async ({ selectAgent }) => {
      const response = await apiFetch(
        `/api/frames/${props.frameId}/agent_bootstrap?select_agent=${selectAgent ? 1 : 0}`,
        {
          method: 'POST',
        }
      )
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        actions.copyAgentBootstrapScriptFailure(
          typeof payload?.detail === 'string' ? payload.detail : 'Failed to create agent bootstrap script'
        )
        return
      }

      const payload = (await response.json()) as AgentBootstrapApiResponse
      copy(payload.command)
      actions.copyAgentBootstrapScriptSuccess()
      framesModel.actions.loadFrame(props.frameId)
    },
  })),
])
