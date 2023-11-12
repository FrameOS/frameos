import { actions, afterMount, connect, kea, listeners, path, reducers, selectors } from 'kea'

import { loaders } from 'kea-loaders'
import { socketLogic } from '../socketLogic'

import type { settingsLogicType } from './settingsLogicType'
import { forms } from 'kea-forms'

function setDefaultSettings(settings: Record<string, any>): Record<string, any> {
  return {
    ...settings,
    home_assistant: settings.home_assistant ?? {},
    github: settings.github ?? {},
    openai: settings.openai ?? {},
    repositories: settings.repositories ?? [],
    ssh_keys: settings.ssh_keys ?? {},
  }
}

// @ts-ignore
export const settingsLogic = kea<settingsLogicType>([
  path(['src', 'scenes', 'settings', 'settingsLogic']),
  connect({ logic: [socketLogic] }),
  actions({
    updateSavedSettings: (settings: Record<string, any>) => ({ settings }),
    newKey: true,
  }),
  loaders(({ values }) => ({
    savedSettings: [
      setDefaultSettings({}),
      {
        loadSettings: async () => {
          try {
            const response = await fetch(`/api/settings`)
            if (!response.ok) {
              throw new Error('Failed to fetch settings')
            }
            const data = await response.json()
            return setDefaultSettings({ ...values.savedSettings, ...data })
          } catch (error) {
            console.error(error)
            return values.savedSettings
          }
        },
      },
    ],
  })),
  reducers({
    savedSettings: {
      updateSavedSettings: (state, { settings }) => setDefaultSettings({ ...state, ...settings }),
    },
  }),
  forms(({ values, actions }) => ({
    settings: {
      defaults: setDefaultSettings({}),
      submit: async (formValues) => {
        const response = await fetch(`/api/settings`, {
          method: 'POST',
          body: JSON.stringify(formValues),
          headers: {
            'Content-Type': 'application/json',
          },
        })
        if (!response.ok) {
          throw new Error('Failed to update frame')
        }
        actions.resetSettings(setDefaultSettings(await response.json()))
      },
    },
  })),
  afterMount(({ actions }) => {
    actions.loadSettings()
  }),
  listeners(({ values, actions }) => ({
    loadSettingsSuccess: ({ savedSettings }) => {
      actions.resetSettings(setDefaultSettings(savedSettings))
    },
    [socketLogic.actionTypes.updateSettings]: ({ settings }) => {
      actions.updateSavedSettings(setDefaultSettings(settings))
      actions.resetSettings(setDefaultSettings({ ...values.savedSettings, ...settings }))
    },
    newKey: async () => {
      if (values.savedSettings.ssh_keys?.default) {
        if (!confirm('Are you sure you want to generate a new key? You might lose access to existing frames.')) {
          return
        }
      }
      const response = await fetch(`/api/generate_ssh_keys`, {
        method: 'POST',
      })
      if (!response.ok) {
        throw new Error('Failed to generate new key')
      }
      const data = await response.json()
      actions.setSettingsValue(['ssh_keys', 'default'], data.private)
      actions.setSettingsValue(['ssh_keys', 'default_public'], `${data.public} frameos@${window.location.hostname}`)
    },
  })),
])
