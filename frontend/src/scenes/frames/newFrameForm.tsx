import { actions, afterMount, kea, listeners, path, reducers } from 'kea'

import { forms } from 'kea-forms'
import { FrameInstallMethod, NewFrameFormType } from '../../types'

import type { newFrameFormType } from './newFrameFormType'
import { framesModel } from '../../models/framesModel'
import { apiFetch } from '../../utils/apiFetch'
import { loaders } from 'kea-loaders'
import { inHassioIngress } from '../../utils/inHassioIngress'
import { BUILDROOT_RASPBERRY_PI_ZERO_2_W } from '../../devices'

function fallbackFrameHost(name?: string | null): string {
  const slug = String(name || 'frame')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${slug || 'frame'}.local`
}

function framePayload(frame: NewFrameFormType): NewFrameFormType {
  const installMethod = frame.install_method ?? (frame.mode === 'buildroot' ? 'sd_card' : 'ssh')

  if (installMethod === 'sd_card') {
    return {
      ...frame,
      mode: 'buildroot',
      frame_host: '',
      platform: frame.platform || BUILDROOT_RASPBERRY_PI_ZERO_2_W,
    }
  }

  if (installMethod === 'script') {
    return {
      ...frame,
      mode: 'rpios',
      frame_host: frame.frame_host || fallbackFrameHost(frame.name),
      agent: {
        ...(frame.agent ?? {}),
        agentEnabled: true,
        agentRunCommands: true,
        deployWithAgent: true,
      },
    }
  }

  return {
    ...frame,
    mode: 'rpios',
    agent: {
      ...(frame.agent ?? {}),
      agentEnabled: false,
      agentRunCommands: false,
      deployWithAgent: false,
    },
  }
}

export const newFrameForm = kea<newFrameFormType>([
  path(['src', 'scenes', 'frames', 'newFrameForm']),
  actions({
    showForm: true,
    hideForm: true,
    setFile: (file: File | null) => ({ file }),
    importFrame: true,
    frameCreated: (frameId: number, installMethod?: FrameInstallMethod) => ({ frameId, installMethod }),
  }),
  reducers({
    file: [
      null as File | null,
      {
        setFile: (_, { file }) => file,
      },
    ],
    formVisible: [
      false,
      {
        showForm: () => true,
        hideForm: () => false,
      },
    ],
  }),
  forms(({ actions }) => ({
    newFrame: {
      defaults: {
        mode: 'rpios',
        install_method: undefined,
        name: '',
        frame_host: '',
        device: 'web_only',
        timezone: '',
        platform: BUILDROOT_RASPBERRY_PI_ZERO_2_W,
        network: {
          wifiSSID: '',
          wifiPassword: '',
        },
        server_host:
          typeof window !== 'undefined'
            ? `${window.location.hostname}:${
                inHassioIngress()
                  ? '8989'
                  : window.location.port || (window.location.protocol === 'https:' ? '443' : '80')
              }`
            : undefined,
      } as NewFrameFormType,
      errors: (frame: Partial<NewFrameFormType>) => ({
        name: !frame.name ? 'Please enter a name' : null,
        frame_host: frame.install_method === 'ssh' && !frame.frame_host ? 'Please enter a host' : null,
        platform:
          frame.install_method === 'sd_card' && !frame.platform
            ? 'Please pick a platform'
            : // no errors for RpiOS, support autodetection
              null,
        network: undefined,
      }),
      submit: async (frame) => {
        try {
          const installMethod = frame.install_method ?? (frame.mode === 'buildroot' ? 'sd_card' : 'ssh')
          const payload = framePayload(frame)
          const response = await apiFetch('/api/frames/new', {
            method: 'POST',
            body: JSON.stringify(payload),
            headers: {
              'Content-Type': 'application/json',
            },
          })

          if (!response.ok) {
            throw new Error('Failed to submit frame')
          }

          actions.resetNewFrame()
          actions.hideForm()
          const result = await response.json()
          if (result?.frame?.id) {
            framesModel.actions.addFrame(result.frame)
            actions.frameCreated(result.frame.id, installMethod)
          }
        } catch (error) {
          console.error(error)
        }
      },
    },
  })),
  loaders(({ actions, values }) => ({
    importingFrame: [
      false as boolean,
      {
        importFrame: async () => {
          const { file } = values
          if (!file) {
            return false
          }

          try {
            const formData = new FormData()
            formData.append('file', file)

            const response = await apiFetch('/api/frames/import', {
              method: 'POST',
              body: formData,
            })

            if (!response.ok) {
              throw new Error('Failed to import frame')
            }
            actions.setFile(null)
            const result = await response.json()
            if (result?.frame?.id) {
              framesModel.actions.addFrame(result.frame)
              actions.hideForm()
              actions.frameCreated(result.frame.id, 'ssh')
            }
          } catch (error) {
            console.error(error)
          }
          return true
        },
      },
    ],
  })),
  listeners(({ actions }) => ({
    [framesModel.actionTypes.loadFramesSuccess]: ({ frames }) => {
      if (Object.keys(frames).length === 0) {
        actions.showForm()
      }
    },
  })),
  afterMount(() => {
    if (!framesModel.values.framesLoading && Object.keys(framesModel.values.frames).length === 0) {
      framesModel.actions.loadFrames()
    }
  }),
])
