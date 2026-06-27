import { actions, afterMount, connect, kea, listeners, path, reducers } from 'kea'
import { loaders } from 'kea-loaders'
import { socketLogic } from '../socketLogic'
import type { settingsLogicType } from './settingsLogicType'
import { forms } from 'kea-forms'
import { FrameOSSettings, SSHKeyEntry } from '../../types'
import { apiFetch } from '../../utils/apiFetch'
import { normalizeSshKeys } from '../../utils/sshKeys'
import { v4 as uuidv4 } from 'uuid'
import { showWorkingMessage } from '../../utils/workingMessage'
import { isFrameControlMode } from '../../utils/frameControlMode'
import { guessBrowserTimezone } from '../../utils/timezone'

function setDefaultSettings(settings: Partial<FrameOSSettings> | Record<string, any>): FrameOSSettings {
  const buildEnvironmentProvider =
    settings.buildEnvironment?.provider ||
    (settings.modalSandbox?.enabled ? 'modal' : settings.buildHost?.enabled ? 'buildHost' : 'docker')
  return {
    ...settings,
    defaults: {
      timezone: guessBrowserTimezone(),
      wifiSSID: '',
      wifiPassword: '',
      backendHost: '',
      backendPort: '',
      ...(settings.defaults ?? {}),
    },
    homeAssistant: settings.homeAssistant ?? {},
    frameOS: settings.frameOS ?? {},
    github: settings.github ?? {},
    openAI: settings.openAI ?? {},
    posthog: settings.posthog ?? {},
    repositories: settings.repositories ?? [],
    ssh_keys: normalizeSshKeys(settings.ssh_keys),
    unsplash: settings.unsplash ?? {},
    buildEnvironment: {
      ...(settings.buildEnvironment ?? {}),
      provider: buildEnvironmentProvider,
    },
    buildHost: settings.buildHost ?? {},
    modalSandbox: settings.modalSandbox ?? {},
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
    toggleOpenAiModelOverrides: true,
    newBuildHostKey: true,
    testBuildHost: true,
    testModalSandbox: true,
    setTestingBuildHost: (testing: boolean) => ({ testing }),
    setTestingModalSandbox: (testing: boolean) => ({ testing }),
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
    openAiModelOverridesExpanded: [
      false,
      {
        toggleOpenAiModelOverrides: (state) => !state,
      },
    ],
    isTestingModalSandbox: [
      false,
      {
        setTestingModalSandbox: (_, { testing }) => testing,
      },
    ],
    isTestingBuildHost: [
      false,
      {
        setTestingBuildHost: (_, { testing }) => testing,
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
    if (isFrameControlMode()) {
      return
    }
    actions.loadSettings()
    actions.loadCustomFonts()
  }),
  listeners(({ values, actions }) => ({
    loadSettingsSuccess: ({ savedSettings }) => {
      actions.resetSettings(setDefaultSettings(savedSettings))
      const savedKeys = normalizeSshKeys(savedSettings.ssh_keys).keys
      const expandedIds = savedKeys.filter((key) => !key.private && !key.public).map((key) => key.id)
      actions.setSshKeyExpandedIds(expandedIds)
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
    testBuildHost: async () => {
      actions.setTestingBuildHost(true)
      const workingMessage = showWorkingMessage('Checking build host connection...')
      try {
        const response = await apiFetch(`/api/settings/test_build_host`, {
          method: 'POST',
          body: JSON.stringify({ buildHost: values.settings.buildHost ?? {} }),
          headers: { 'Content-Type': 'application/json' },
        })
        if (!response.ok) {
          const data = await response.json().catch(() => null)
          throw new Error(data?.detail || 'Build host connection check failed')
        }
        workingMessage.success('Build host connection check succeeded')
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Build host connection check failed'
        workingMessage.error(message)
        throw error
      } finally {
        actions.setTestingBuildHost(false)
      }
    },
    testModalSandbox: async () => {
      actions.setTestingModalSandbox(true)
      const workingMessage = showWorkingMessage('Testing Modal sandbox...')
      try {
        const response = await apiFetch(`/api/settings/test_modal_sandbox`, {
          method: 'POST',
          body: JSON.stringify({ modalSandbox: { ...(values.settings.modalSandbox ?? {}), enabled: true } }),
          headers: { 'Content-Type': 'application/json' },
        })
        if (!response.ok) {
          const data = await response.json().catch(() => null)
          throw new Error(data?.detail || 'Modal sandbox test failed')
        }
        workingMessage.success('Modal sandbox test succeeded')
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Modal sandbox test failed'
        workingMessage.error(message)
        throw error
      } finally {
        actions.setTestingModalSandbox(false)
      }
    },
  })),
])
