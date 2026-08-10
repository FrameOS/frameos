import { actions, afterMount, kea, listeners, path, reducers } from 'kea'

import { forms } from 'kea-forms'
import { FrameInstallMethod, FrameOSSettings, NewFrameFormType, FrameId } from '../../types'

import type { newFrameFormType } from './newFrameFormType'
import { framesModel } from '../../models/framesModel'
import { apiFetch } from '../../utils/apiFetch'
import { loaders } from 'kea-loaders'
import { BUILDROOT_RASPBERRY_PI_ZERO_2_W, EMBEDDED_ESP32_S3 } from '../../devices'
import { settingsLogic } from '../settings/settingsLogic'
import { defaultNewFrameServerHost } from '../../utils/backendAddress'

function defaultWifiNetwork(settings: FrameOSSettings): NonNullable<NewFrameFormType['network']> {
  return {
    wifiSSID: settings.defaults?.wifiSSID ?? '',
    wifiPassword: settings.defaults?.wifiPassword ?? '',
  }
}

function fallbackFrameHost(name?: string | null): string {
  const slug = String(name || 'frame')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${slug || 'frame'}.local`
}

export function installMethodOf(frame: NewFrameFormType): FrameInstallMethod {
  return frame.install_method ?? (frame.mode === 'buildroot' ? 'sd_card' : 'ssh')
}

// Whether FrameOS Remote (the reverse tunnel from frame to backend) should be
// on for a frame installed this way, when the user has not said otherwise.
// SSH installs are by definition backend-can-reach-frame, so they start
// SSH-only; the script and SD-card paths exist precisely for frames the
// backend cannot dial into, so they start with Remote on.
export function defaultRemoteControl(installMethod: FrameInstallMethod): boolean {
  return installMethod !== 'ssh'
}

export function remoteControlEnabled(frame: NewFrameFormType): boolean {
  return frame.agent?.agentEnabled ?? defaultRemoteControl(installMethodOf(frame))
}

// The three agent flags always move together from this form: a frame either
// is driven over FrameOS Remote or it is not. Finer-grained control (running
// commands but not deploying, say) lives in frame settings afterwards.
function agentPayload(frame: NewFrameFormType): NonNullable<NewFrameFormType['agent']> {
  const enabled = remoteControlEnabled(frame)
  return {
    ...(frame.agent ?? {}),
    agentEnabled: enabled,
    agentRunCommands: enabled,
    deployWithAgent: enabled,
  }
}

function framePayload(frame: NewFrameFormType): NewFrameFormType {
  // width/height are not part of FrameCreateRequest (the backend would drop
  // them silently); they are applied with a follow-up update after creation.
  const { rememberWifi: _rememberWifi, width: _width, height: _height, ...frameValues } = frame
  const installMethod = installMethodOf(frame)
  const agent = agentPayload(frame)

  if (installMethod === 'sd_card') {
    return {
      ...frameValues,
      mode: 'buildroot',
      frame_host: '',
      platform: frameValues.platform || BUILDROOT_RASPBERRY_PI_ZERO_2_W,
      agent,
    }
  }

  if (installMethod === 'embedded') {
    return {
      ...frameValues,
      mode: 'embedded',
      frame_host: '',
      platform: frameValues.platform || EMBEDDED_ESP32_S3,
    }
  }

  if (installMethod === 'script') {
    // Not a choice: the generated command installs FrameOS Remote and connects
    // it back here — that is the entire point of the script install, and it is
    // the only way in for a frame this backend cannot reach. Forced on rather
    // than defaulted so a toggle left off in another tab cannot produce a
    // frame with no way to talk to it.
    return {
      ...frameValues,
      mode: 'rpios',
      frame_host: frameValues.frame_host || fallbackFrameHost(frameValues.name),
      agent: {
        ...(frameValues.agent ?? {}),
        agentEnabled: true,
        agentRunCommands: true,
        deployWithAgent: true,
      },
    }
  }

  return {
    ...frameValues,
    mode: 'rpios',
    agent,
  }
}

async function saveRememberedWifiDefaults(frame: NewFrameFormType): Promise<void> {
  const installMethod = frame.install_method ?? (frame.mode === 'buildroot' ? 'sd_card' : 'ssh')
  if ((installMethod !== 'sd_card' && installMethod !== 'embedded') || !frame.rememberWifi) {
    return
  }

  const currentResponse = await apiFetch('/api/settings')
  if (!currentResponse.ok) {
    throw new Error('Failed to fetch default WiFi settings')
  }
  const currentSettings = (await currentResponse.json()) as FrameOSSettings
  const defaults = {
    ...(currentSettings.defaults ?? {}),
    wifiSSID: frame.network?.wifiSSID ?? '',
    wifiPassword: frame.network?.wifiPassword ?? '',
  }
  const response = await apiFetch('/api/settings', {
    method: 'POST',
    body: JSON.stringify({ defaults }),
    headers: {
      'Content-Type': 'application/json',
    },
  })
  if (!response.ok) {
    throw new Error('Failed to update default WiFi settings')
  }
  settingsLogic.actions.updateSavedSettings(await response.json())
}

export const newFrameForm = kea<newFrameFormType>([
  path(['src', 'scenes', 'frames', 'newFrameForm']),
  actions({
    showForm: true,
    hideForm: true,
    setFile: (file: File | null) => ({ file }),
    importFrame: true,
    frameCreated: (frameId: FrameId, installMethod?: FrameInstallMethod) => ({ frameId, installMethod }),
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
        rememberWifi: true,
        server_host: defaultNewFrameServerHost(),
      } as NewFrameFormType,
      errors: (frame: Partial<NewFrameFormType>) => ({
        name: !frame.name ? 'Please enter a name' : null,
        frame_host: frame.install_method === 'ssh' && !frame.frame_host ? 'Please enter a host' : null,
        platform:
          (frame.install_method === 'sd_card' || frame.install_method === 'embedded') && !frame.platform
            ? 'Please pick a platform'
            : // no errors for RpiOS, support autodetection
              null,
        device: frame.install_method === 'embedded' && !frame.device ? 'Please pick a display panel' : null,
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

          const result = await response.json()
          let createdFrame = result?.frame
          // FrameCreateRequest carries no width/height, so a virtual frame's
          // chosen size is applied through the regular frame-update endpoint
          // right after creation.
          const sizeUpdate = {
            ...(frame.width ? { width: frame.width } : {}),
            ...(frame.height ? { height: frame.height } : {}),
          }
          if (createdFrame?.id && Object.keys(sizeUpdate).length > 0) {
            try {
              const updateResponse = await apiFetch(`/api/frames/${createdFrame.id}`, {
                method: 'POST',
                body: JSON.stringify(sizeUpdate),
                headers: {
                  'Content-Type': 'application/json',
                },
              })
              if (updateResponse.ok) {
                createdFrame = { ...createdFrame, ...sizeUpdate }
              } else {
                console.error('Failed to apply frame size after creation')
              }
            } catch (error) {
              console.error(error)
            }
          }
          try {
            await saveRememberedWifiDefaults(frame)
          } catch (error) {
            console.error(error)
          }
          actions.resetNewFrame()
          actions.hideForm()
          if (createdFrame?.id) {
            framesModel.actions.addFrame(createdFrame)
            actions.frameCreated(createdFrame.id, installMethod)
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
  listeners(({ actions, values }) => ({
    [framesModel.actionTypes.loadFramesSuccess]: ({ frames }) => {
      if (Object.keys(frames).length === 0) {
        actions.showForm()
      }
    },
    [settingsLogic.actionTypes.loadSettingsSuccess]: ({ savedSettings }: { savedSettings: FrameOSSettings }) => {
      const network = values.newFrame.network ?? {}
      if (values.newFrame.install_method === 'sd_card' && !network.wifiSSID && !network.wifiPassword) {
        actions.setNewFrameValue('network', defaultWifiNetwork(savedSettings))
      }
      const configuredServerHost = defaultNewFrameServerHost(savedSettings)
      const currentServerHost = values.newFrame.server_host ?? ''
      const fallbackServerHost = defaultNewFrameServerHost() ?? ''
      if (configuredServerHost && (!currentServerHost || currentServerHost === fallbackServerHost)) {
        actions.setNewFrameValue('server_host', configuredServerHost)
      }
    },
  })),
  afterMount(() => {
    if (!framesModel.values.framesLoading && Object.keys(framesModel.values.frames).length === 0) {
      framesModel.actions.loadFrames()
    }
  }),
])
