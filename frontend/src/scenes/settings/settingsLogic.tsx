import { actions, afterMount, connect, defaults, events, kea, listeners, path, reducers, selectors } from 'kea'
import { loaders } from 'kea-loaders'
import { socketLogic } from '../socketLogic'
import type { settingsLogicType } from './settingsLogicType'
import { forms } from 'kea-forms'
import { FrameOSSettings, SSHKeyEntry } from '../../types'
import { apiFetch } from '../../utils/apiFetch'
import { normalizeSshKeys } from '../../utils/sshKeys'
import { v4 as uuidv4 } from 'uuid'
import { showWorkingMessage } from '../../utils/workingMessage'

const embeddingsGeneratingStorageKey = 'frameos.embeddings.generating'

function setDefaultSettings(settings: Partial<FrameOSSettings> | Record<string, any>): FrameOSSettings {
  return {
    ...settings,
    homeAssistant: settings.homeAssistant ?? {},
    frameOS: settings.frameOS ?? {},
    github: settings.github ?? {},
    openAI: settings.openAI ?? {},
    posthog: settings.posthog ?? {},
    repositories: settings.repositories ?? [],
    ssh_keys: normalizeSshKeys(settings.ssh_keys),
    unsplash: settings.unsplash ?? {},
    nix: settings.nix ?? {},
    buildHost: settings.buildHost ?? {},
    frameAdminAuth: settings.frameAdminAuth ?? { enabled: false, user: "", pass: "" },
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
    setSshKeyExpandedIds: (ids: string[]) => ({ ids }),
    setSshKeyExpanded: (id: string, expanded: boolean) => ({ id, expanded }),
    toggleSshKeyExpanded: (id: string) => ({ id }),
    newNixKey: true,
    newBuildHostKey: true,
    setGeneratingSshKeyId: (id: string | null) => ({ id }),
    setIsGeneratingEmbeddings: (isGenerating: boolean) => ({ isGenerating }),
    setIsDeletingEmbeddings: (isDeleting: boolean) => ({ isDeleting }),
    setEmbeddingsPollingIntervalId: (id: number | null) => ({ id }),
    startEmbeddingsPolling: true,
    stopEmbeddingsPolling: true,
    generateMissingEmbeddings: true,
    deleteEmbeddings: true,
    regenerateFrameAdminPassword: true,
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
    sshKeyExpandedIds: [
      [] as string[],
      {
        setSshKeyExpandedIds: (_, { ids }) => ids,
        setSshKeyExpanded: (state, { id, expanded }) =>
          expanded ? (state.includes(id) ? state : [...state, id]) : state.filter((keyId) => keyId !== id),
        toggleSshKeyExpanded: (state, { id }) =>
          state.includes(id) ? state.filter((keyId) => keyId !== id) : [...state, id],
      },
    ],
    isGeneratingEmbeddings: [
      false,
      {
        setIsGeneratingEmbeddings: (_, { isGenerating }) => isGenerating,
      },
    ],
    isDeletingEmbeddings: [
      false,
      {
        setIsDeletingEmbeddings: (_, { isDeleting }) => isDeleting,
      },
    ],
    embeddingsPollingIntervalId: [
      null as number | null,
      {
        setEmbeddingsPollingIntervalId: (_, { id }) => id,
      },
    ],
  }),
  selectors({
    embeddingsCount: [
      (selectors) => [selectors.aiEmbeddingsStatus],
      (aiEmbeddingsStatus) => aiEmbeddingsStatus?.count ?? 0,
    ],
    embeddingsTotal: [
      (selectors) => [selectors.aiEmbeddingsStatus],
      (aiEmbeddingsStatus) => aiEmbeddingsStatus?.total ?? 0,
    ],
    embeddingsMissing: [
      (selectors) => [selectors.aiEmbeddingsStatus],
      (aiEmbeddingsStatus) => Math.max((aiEmbeddingsStatus?.total ?? 0) - (aiEmbeddingsStatus?.count ?? 0), 0),
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
        if (!formValues.files.length) {
          return
        }

        const workingMessage = showWorkingMessage('Uploading assets...')
        try {
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
          workingMessage.success('Assets uploaded successfully')
          actions.loadCustomFonts()
          actions.resetCustomFontsForm()
        } catch (error) {
          workingMessage.error(error instanceof Error ? error.message : 'Failed to upload assets')
          throw error
        }
      },
    },
  })),
  afterMount(({ actions }) => {
    actions.loadSettings()
    actions.loadAiEmbeddingsStatus()
    actions.loadCustomFonts()
    if (window.localStorage.getItem(embeddingsGeneratingStorageKey) === 'true') {
      actions.setIsGeneratingEmbeddings(true)
      actions.startEmbeddingsPolling()
    }
  }),
  events(({ actions }) => ({
    beforeUnmount: () => {
      actions.stopEmbeddingsPolling()
    },
  })),
  listeners(({ values, asyncActions, actions }) => ({
    loadSettingsSuccess: ({ savedSettings }) => {
      actions.resetSettings(setDefaultSettings(savedSettings))
      const savedKeys = normalizeSshKeys(savedSettings.ssh_keys).keys
      const expandedIds = savedKeys.filter((key) => !key.private && !key.public).map((key) => key.id)
      actions.setSshKeyExpandedIds(expandedIds)
    },
    loadAiEmbeddingsStatusSuccess: ({ aiEmbeddingsStatus }) => {
      const missing = Math.max(aiEmbeddingsStatus.total - aiEmbeddingsStatus.count, 0)
      if (values.isGeneratingEmbeddings && missing === 0) {
        actions.setIsGeneratingEmbeddings(false)
        actions.stopEmbeddingsPolling()
        window.localStorage.removeItem(embeddingsGeneratingStorageKey)
      }
    },
    startEmbeddingsPolling: () => {
      if (values.embeddingsPollingIntervalId !== null) {
        return
      }
      actions.loadAiEmbeddingsStatus()
      const intervalId = window.setInterval(() => {
        actions.loadAiEmbeddingsStatus()
      }, 1000)
      actions.setEmbeddingsPollingIntervalId(intervalId)
    },
    stopEmbeddingsPolling: () => {
      if (values.embeddingsPollingIntervalId === null) {
        return
      }
      window.clearInterval(values.embeddingsPollingIntervalId)
      actions.setEmbeddingsPollingIntervalId(null)
    },
    generateMissingEmbeddings: async () => {
      if (values.isGeneratingEmbeddings) {
        return
      }
      actions.setIsGeneratingEmbeddings(true)
      window.localStorage.setItem(embeddingsGeneratingStorageKey, 'true')
      actions.startEmbeddingsPolling()
      try {
        await asyncActions.generateMissingAiEmbeddings()
      } catch (error) {
        actions.setIsGeneratingEmbeddings(false)
        actions.stopEmbeddingsPolling()
        window.localStorage.removeItem(embeddingsGeneratingStorageKey)
        throw error
      }
    },
    deleteEmbeddings: async () => {
      if (values.isDeletingEmbeddings) {
        return
      }
      if (!window.confirm('Delete all embeddings? This might be costly to redo.')) {
        return
      }
      actions.setIsDeletingEmbeddings(true)
      actions.startEmbeddingsPolling()
      try {
        await asyncActions.deleteAiEmbeddings()
      } finally {
        actions.setIsDeletingEmbeddings(false)
        actions.loadAiEmbeddingsStatus()
        actions.stopEmbeddingsPolling()
      }
    },
    [socketLogic.actionTypes.updateSettings]: ({ settings }) => {
      actions.updateSavedSettings(setDefaultSettings(settings))
      actions.resetSettings(setDefaultSettings({ ...values.savedSettings, ...settings }))
    },
    regenerateFrameAdminPassword: () => {
      const bytes = new Uint8Array(18)
      window.crypto.getRandomValues(bytes)
      const password = btoa(String.fromCharCode(...bytes)).replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)
      actions.setSettingsValue(['frameAdminAuth', 'pass'], password)
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
      actions.setSshKeyExpanded(keyId, true)
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
      actions.setSshKeyExpanded(id, false)
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
