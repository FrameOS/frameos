import { actions, afterMount, connect, kea, listeners, path, reducers, selectors } from 'kea'
import { loaders } from 'kea-loaders'
import { AgentType } from '../types'
import { socketLogic } from '../scenes/socketLogic'
import { router } from 'kea-router'
import { apiFetch } from '../utils/apiFetch'
import { urls } from '../urls'

import type { agentsModelType } from './agentsModelType'

export const agentsModel = kea<agentsModelType>([
  connect({ logic: [socketLogic] }),
  path(['src', 'models', 'agentsModel']),
  actions({
    addAgent: (agent: AgentType) => ({ agent }),
    loadAgent: (id: number) => ({ id }),
    deleteAgent: (id: number) => ({ id }),
  }),
  loaders(({ values }) => ({
    agents: [
      {} as Record<number, AgentType>,
      {
        loadAgent: async ({ id }) => {
          try {
            const response = await apiFetch(`/api/agents/${id}`)
            if (!response.ok) {
              throw new Error('Failed to fetch agent')
            }
            const data = await response.json()
            const agent = data.agent as AgentType
            return {
              ...values.agents,
              [agent.id]: agent,
            }
          } catch (error) {
            console.error(error)
            return values.agents
          }
        },
        loadAgents: async () => {
          try {
            const response = await apiFetch('/api/agents')
            if (!response.ok) {
              throw new Error('Failed to fetch agents')
            }
            const data = await response.json()
            return Object.fromEntries((data.agents as AgentType[]).map((agent) => [agent.id, agent]))
          } catch (error) {
            console.error(error)
            return values.agents
          }
        },
      },
    ],
  })),
  reducers(() => ({
    agents: [
      {} as Record<number, AgentType>,
      {
        [socketLogic.actionTypes.newAgent]: (state, { agent }) => ({ ...state, [agent.id]: agent }),
        [socketLogic.actionTypes.updateAgent]: (state, { agent }) => ({ ...state, [agent.id]: agent }),
        [socketLogic.actionTypes.deleteAgent]: (state, { id }) => {
          const newState = { ...state }
          delete newState[id]
          return newState
        },
      },
    ],
  })),
  selectors({
    agentsList: [
      (s) => [s.agents],
      (agents) => Object.values(agents).sort((a, b) => a.device_id.localeCompare(b.device_id)) as AgentType[],
    ],
  }),
  afterMount(({ actions }) => {
    actions.loadAgents()
  }),
  listeners(({ actions, values }) => ({
    deleteAgent: async ({ id }) => {
      await apiFetch(`/api/agents/${id}`, { method: 'DELETE' })
      if (router.values.location.pathname.includes('/agents/' + id)) {
        router.actions.push(urls.frames())
      }
    },
  })),
])
