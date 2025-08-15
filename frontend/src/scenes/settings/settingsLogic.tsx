import { actions, afterMount, connect, defaults, kea, listeners, path, reducers, selectors } from 'kea'
import { loaders } from 'kea-loaders'
import { socketLogic } from '../socketLogic'
import type { settingsLogicType } from './settingsLogicType'
import { forms } from 'kea-forms'
import { FrameOSSettings } from '../../types'
import { apiFetch } from '../../utils/apiFetch'

function setDefaultSettings(settings: Partial<FrameOSSettings> | Record<string, any>): FrameOSSettings {
  return {
    ...settings,
    homeAssistant: settings.homeAssistant ?? {},
    frameOS: settings.frameOS ?? {},
    github: settings.github ?? {},
    openAI: settings.openAI ?? {},
    repositories: settings.repositories ?? [],
    ssh_keys: settings.ssh_keys ?? {},
    unsplash: settings.unsplash ?? {},
    nix: settings.nix ?? {},
  }
}

export interface CustomFont {
  id: string
  path: string
  size: number
}

export const settingsLogic = kea<settingsLogicType>([
  path(['src', 'scenes', 'settings', 'settingsLogic']),
  connect({ logic: [socketLogic] }),
  actions({
    updateSavedSettings: (settings: Record<string, any>) => ({ settings }),
    newKey: true,
    newNixKey: true,
  }),
  loaders(({ values }) => ({
    savedSettings: [
      setDefaultSettings({}),
      {
        loadSettings: async () => {
          try {
            const response = await apiFetch(`/api/settings`)
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
    customFonts: [
      [] as CustomFont[],
      {
        loadCustomFonts: async () => {
          try {
            const response = await apiFetch(`/api/assets`)
            if (!response.ok) {
              throw new Error('Failed to fetch assets')
            }
            const data = await response.json()
            return data.filter((asset: CustomFont) => asset.path.startsWith('fonts/') && asset.path.endsWith('.ttf'))
          } catch (error) {
            console.error(error)
            return values.customFonts
          }
        },
        deleteCustomFont: async (font: CustomFont) => {
          const response = await apiFetch(`/api/assets/${font.id}`, {
            method: 'DELETE',
          })
          if (!response.ok) {
            throw new Error('Failed to delete font')
          }
          return values.customFonts.filter((f) => f.id !== font.id)
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
        const response = await apiFetch(`/api/settings`, {
          method: 'POST',
          body: JSON.stringify(formValues),
          headers: { 'Content-Type': 'application/json' },
        })
        if (!response.ok) {
          throw new Error('Failed to update frame')
        }
        actions.resetSettings(setDefaultSettings(await response.json()))
      },
    },
    customFontsForm: {
      defaults: { files: [] } as { files: File[] },
      submit: async (formValues) => {
        for (const file of formValues.files) {
          const formData = new FormData()
          formData.append('path', `fonts/${file.name}`)
          formData.append('file', file)

          const response = await apiFetch(`/api/assets`, {
            method: 'POST',
            body: formData,
          })
          if (!response.ok) {
            throw new Error(`Failed to upload file: ${file.name}`)
          }
        }
        actions.loadCustomFonts()
        actions.resetCustomFontsForm()
      },
    },
  })),
  afterMount(({ actions }) => {
    actions.loadSettings()
    actions.loadCustomFonts()
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
      const response = await apiFetch(`/api/generate_ssh_keys`, {
        method: 'POST',
      })
      if (!response.ok) {
        throw new Error('Failed to generate new key')
      }
      const data = await response.json()
      actions.setSettingsValue(['ssh_keys', 'default'], data.private)
      actions.setSettingsValue(['ssh_keys', 'default_public'], `${data.public} frameos@${window.location.hostname}`)
    },
    newNixKey: async () => {
      if (values.savedSettings.ssh_keys?.default) {
        if (
          !confirm('Are you sure you want to generate a new key? You might lose access to the existing build server.')
        ) {
          return
        }
      }
      const response = await apiFetch(`/api/generate_ssh_keys`, {
        method: 'POST',
      })
      if (!response.ok) {
        throw new Error('Failed to generate new key')
      }
      const data = await response.json()
      actions.setSettingsValue(['nix', 'buildServerPrivateKey'], data.private)
      actions.setSettingsValue(
        ['nix', 'buildServerPublicKey'],
        `${data.public} frameos-build@${window.location.hostname}`
      )
    },
  })),
])
