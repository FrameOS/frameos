import { actions, afterMount, connect, defaults, kea, listeners, path, reducers, selectors } from 'kea'
import { loaders } from 'kea-loaders'
import { socketLogic } from '../socketLogic'
import type { settingsLogicType } from './settingsLogicType'
import { forms } from 'kea-forms'
import { FrameOSSettings, SSHKeyEntry } from '../../types'
import { apiFetch } from '../../utils/apiFetch'
import { normalizeSshKeys } from '../../utils/sshKeys'
import { v4 as uuidv4 } from 'uuid'

function setDefaultSettings(settings: Partial<FrameOSSettings> | Record<string, any>): FrameOSSettings {
  return {
    ...settings,
    homeAssistant: settings.homeAssistant ?? {},
    frameOS: settings.frameOS ?? {},
    github: settings.github ?? {},
    openAI: settings.openAI ?? {},
    repositories: settings.repositories ?? [],
    ssh_keys: normalizeSshKeys(settings.ssh_keys),
    unsplash: settings.unsplash ?? {},
    nix: settings.nix ?? {},
    buildHost: settings.buildHost ?? {},
  }
}

export interface CustomFont {
  id: string
  path: string
  size: number
}

export const settingsLogic = kea<settingsLogicType>([
  path(['src', 'scenes', 'settings', 'settingsLogic']),
  connect(() => ({ logic: [socketLogic] })),
  actions({
    updateSavedSettings: (settings: Record<string, any>) => ({ settings }),
    addSshKey: true,
    generateSshKey: (id: string) => ({ id }),
    removeSshKey: (id: string) => ({ id }),
    newNixKey: true,
    newBuildHostKey: true,
    setGeneratingSshKeyId: (id: string | null) => ({ id }),
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
    aiEmbeddingsStatus: [
      { count: 0, total: 0 },
      {
        loadAiEmbeddingsStatus: async () => {
          try {
            const response = await apiFetch(`/api/ai/embeddings/status`)
            if (!response.ok) {
              throw new Error('Failed to fetch AI embeddings status')
            }
            return await response.json()
          } catch (error) {
            console.error(error)
            return values.aiEmbeddingsStatus
          }
        },
        generateMissingAiEmbeddings: async () => {
          const response = await apiFetch(`/api/ai/embeddings/generate-missing`, {
            method: 'POST',
          })
          if (!response.ok) {
            throw new Error('Failed to regenerate AI embeddings')
          }
          return await response.json()
        },
        deleteAiEmbeddings: async () => {
          const response = await apiFetch(`/api/ai/embeddings`, {
            method: 'DELETE',
          })
          if (!response.ok) {
            throw new Error('Failed to delete AI embeddings')
          }
          return await response.json()
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
    generatingSshKeyId: [
      null as string | null,
      {
        setGeneratingSshKeyId: (_, { id }) => id,
      },
    ],
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
    actions.loadAiEmbeddingsStatus()
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
    addSshKey: async () => {
      const keyId = uuidv4()
      const keys = values.settings.ssh_keys?.keys ?? []
      actions.setSettingsValue(['ssh_keys', 'keys'] as any, [
        ...keys,
        {
          id: keyId,
          name: `Key ${keys.length + 1}`,
          private: '',
          public: '',
          use_for_new_frames: keys.length === 0,
        } satisfies SSHKeyEntry,
      ])
    },
    generateSshKey: async ({ id }) => {
      actions.setGeneratingSshKeyId(id)
      try {
        const response = await apiFetch(`/api/generate_ssh_keys`, {
          method: 'POST',
        })
        if (!response.ok) {
          throw new Error('Failed to generate new key')
        }
        const data = await response.json()
        const keys = values.settings.ssh_keys?.keys ?? []
        actions.setSettingsValue(
          ['ssh_keys', 'keys'] as any,
          keys.map((key) =>
            key.id === id
              ? ({
                  ...key,
                  private: data.private,
                  public: `${data.public} frameos@${window.location.hostname}`,
                } satisfies SSHKeyEntry)
              : key
          )
        )
      } finally {
        actions.setGeneratingSshKeyId(null)
      }
    },
    removeSshKey: async ({ id }) => {
      const keys = values.settings.ssh_keys?.keys ?? []
      if (keys.length <= 1) {
        return
      }
      actions.setSettingsValue(
        ['ssh_keys', 'keys'] as any,
        keys.filter((key) => key.id !== id)
      )
    },
    newNixKey: async () => {
      if (values.savedSettings.nix?.buildServerPrivateKey) {
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
    newBuildHostKey: async () => {
      if (values.savedSettings.buildHost?.sshKey) {
        if (
          !confirm('Are you sure you want to generate a new key? You might lose access to the existing build host.')
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
      actions.setSettingsValue(['buildHost', 'sshKey'], data.private)
      actions.setSettingsValue(
        ['buildHost', 'sshPublicKey'],
        `${data.public} frameos-buildhost@${window.location.hostname}`
      )
    },
  })),
])
