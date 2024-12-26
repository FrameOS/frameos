import { actions, afterMount, kea, listeners, path, reducers, selectors } from 'kea'

import { forms } from 'kea-forms'
import { FrameType } from '../../types'

import type { newFrameFormType } from './newFrameFormType'
import { framesModel } from '../../models/framesModel'
import { router } from 'kea-router'
import { apiFetch } from '../../utils/apiFetch'

export const newFrameForm = kea<newFrameFormType>([
  path(['src', 'scenes', 'frames', 'newFrameForm']),
  actions({ showForm: true, hideForm: true }),
  reducers({
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
                window.location.port || (window.location.protocol === 'https:' ? 443 : 80)
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
            router.actions.push(`/frames/${result.frame.id}`)
          }
        } catch (error) {
          console.error(error)
        }
      },
    },
  })),
  listeners(({ actions }) => ({
    [framesModel.actionTypes.loadFramesSuccess]: ({ frames }) => {
      if (Object.keys(frames).length === 0) {
        actions.showForm()
      }
    },
  })),
  afterMount(({ actions }) => {
    if (!framesModel.values.framesLoading && Object.keys(framesModel.values.frames).length === 0) {
      framesModel.actions.loadFrames()
    }
  }),
])
