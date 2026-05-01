import { actions, afterMount, kea, listeners, path, reducers } from 'kea'

import { forms } from 'kea-forms'
import { NewFrameFormType } from '../../types'

import type { newFrameFormType } from './newFrameFormType'
import { framesModel } from '../../models/framesModel'
import { router } from 'kea-router'
import { apiFetch } from '../../utils/apiFetch'
import { urls } from '../../urls'
import { loaders } from 'kea-loaders'
import { defaultsForBuildrootPlatform, t113S3BuildrootDefaults, t113S3BuildrootPlatformValue } from '../../devices'

export const newFrameForm = kea<newFrameFormType>([
  path(['src', 'scenes', 'frames', 'newFrameForm']),
  actions({
    showForm: true,
    hideForm: true,
    setFile: (file: File | null) => ({ file }),
    importFrame: true,
    selectRpiosMode: true,
    selectBuildrootMode: true,
    selectBuildrootPlatform: (platform: string) => ({ platform }),
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
        name: '',
        frame_host: '',
        device: 'web_only',
        platform: 'pi-zero2',
        buildroot: t113S3BuildrootDefaults,
        server_host:
          typeof window !== 'undefined'
            ? `${window.location.hostname}:${
                window.location.port === '8123'
                  ? '8989' // using ingress with home assistant
                  : window.location.port || (window.location.protocol === 'https:' ? '443' : '80')
              }`
            : undefined,
      } as NewFrameFormType,
      errors: (frame: Partial<NewFrameFormType>) => ({
        name: !frame.name ? 'Please enter a name' : null,
        frame_host: frame.mode === 'rpios' && !frame.frame_host ? 'Please enter a host' : null,
        buildroot:
          frame.mode === 'buildroot' && !(frame.buildroot?.platform || frame.platform)
            ? { platform: 'Please pick a platform' }
            : undefined,
      }),
      submit: async (frame) => {
        try {
          const buildrootPlatform = frame.buildroot?.platform || frame.platform || ''
          const body =
            frame.mode === 'buildroot'
              ? {
                  ...frame,
                  platform: buildrootPlatform,
                  buildroot: {
                    ...defaultsForBuildrootPlatform(buildrootPlatform),
                    ...(frame.buildroot || {}),
                    platform: buildrootPlatform,
                  },
                }
              : frame
          const response = await apiFetch('/api/frames/new', {
            method: 'POST',
            body: JSON.stringify(body),
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
            router.actions.push(urls.frame(result.frame.id))
          }
        } catch (error) {
          console.error(error)
        }
      },
    },
  })),
  listeners(({ actions, values }) => ({
    selectRpiosMode: () => {
      actions.setNewFrameValues({ mode: 'rpios', platform: null })
    },
    selectBuildrootMode: () => {
      const currentPlatform = values.newFrame.buildroot?.platform || t113S3BuildrootPlatformValue
      actions.setNewFrameValues({
        mode: 'buildroot',
        device: currentPlatform === t113S3BuildrootPlatformValue ? 'waveshare.EPD_7in3e' : values.newFrame.device,
        platform: currentPlatform,
        buildroot: {
          ...defaultsForBuildrootPlatform(currentPlatform),
          ...(values.newFrame.buildroot || {}),
          platform: currentPlatform,
        },
      })
    },
    selectBuildrootPlatform: ({ platform }) => {
      actions.setNewFrameValues({
        mode: 'buildroot',
        device: platform === t113S3BuildrootPlatformValue ? 'waveshare.EPD_7in3e' : values.newFrame.device,
        platform,
        buildroot: {
          ...(values.newFrame.buildroot || {}),
          ...defaultsForBuildrootPlatform(platform),
          platform,
        },
      })
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
              router.actions.push(urls.frame(result.frame.id))
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
