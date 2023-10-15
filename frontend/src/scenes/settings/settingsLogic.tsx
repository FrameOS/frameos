import { actions, afterMount, connect, kea, listeners, path, reducers, selectors } from 'kea'

import { loaders } from 'kea-loaders'
import { socketLogic } from '../socketLogic'

import type { settingsLogicType } from './settingsLogicType'
import { forms } from 'kea-forms'

export const settingsLogic = kea<settingsLogicType>([
  path(['src', 'scenes', 'settings', 'settingsLogic']),
  connect({ logic: [socketLogic] }),
  actions({
    updateSettings: (settings: Record<string, any>) => ({ settings }),
  }),
  loaders(({ values }) => ({
    settings: [
      {} as Record<string, any>,
      {
        loadSettings: async () => {
          try {
            const response = await fetch(`/api/settings`)
            if (!response.ok) {
              throw new Error('Failed to fetch logs')
            }
            const data = await response.json()
            return { ...values.settings, ...data }
          } catch (error) {
            console.error(error)
            return values.settings
          }
        },
      },
    ],
  })),
  forms({
    settings: {
      defaults: {},
      submit: () => {
        debugger
      },
    },
  }),
  reducers({
    settings: { updateSettings: (state, { settings }) => ({ ...state, ...settings }) },
  }),
  afterMount(({ actions }) => {
    actions.loadSettings()
  }),
  listeners(({ props, actions }) => ({
    [socketLogic.actionTypes.updateSettings]: ({ settings }) => {
      actions.updateSettings(settings)
    },
  })),
])
