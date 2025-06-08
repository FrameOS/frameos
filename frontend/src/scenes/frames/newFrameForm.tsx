import { actions, afterMount, kea, listeners, path, reducers } from 'kea'

import { forms } from 'kea-forms'
import { FrameType } from '../../types'

import type { newFrameFormType } from './newFrameFormType'
import { framesModel } from '../../models/framesModel'
import { router } from 'kea-router'
import { apiFetch } from '../../utils/apiFetch'
import { urls } from '../../urls'
import { loaders } from 'kea-loaders'

export const newFrameForm = kea<newFrameFormType>([
  path(['src', 'scenes', 'frames', 'newFrameForm']),
  actions({
    showForm: true,
    hideForm: true,
    setMode: (name: string) => ({ name }),
    setFile: (file: File | null) => ({ file }),
    importFrame: true,
  }),
  reducers({
    mode: [
      'create' as 'create' | 'import',
      {
        setMode: (_, { name }) => (name === 'import' ? 'import' : 'create'),
      },
    ],
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
        name: '',
        frame_host: '',
        device: 'web_only',
        server_host:
          typeof window !== 'undefined'
            ? `${window.location.hostname}:${
                window.location.port === '8123'
                  ? '8989' // using ingress with home assistant
                  : window.location.port || (window.location.protocol === 'https:' ? '443' : '80')
              }`
            : null,
      } as FrameType,
      errors: (frame: Partial<FrameType>) => ({
        name: !frame.name ? 'Please enter a name' : null,
        frame_host: !frame.frame_host ? 'Please enter a host' : null,
      }),
      submit: async (frame) => {
        try {
          const response = await apiFetch('/api/frames/new', {
            method: 'POST',
            body: JSON.stringify(frame),
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
            router.actions.push(urls.frame(result.frame.id))
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
