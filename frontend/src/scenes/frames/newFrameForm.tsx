import { actions, afterMount, kea, listeners, path, reducers, selectors } from 'kea'

import { forms } from 'kea-forms'
import { FrameType } from '../../types'

import type { newFrameFormType } from './newFrameFormType'

export const newFrameForm = kea<newFrameFormType>([
  path(['src', 'scenes', 'frames', 'newFrameForm']),
  forms(({ actions }) => ({
    newFrame: {
      defaults: {
        api_host: typeof window !== 'undefined' ? `${window.location.hostname}:${window.location.port}` : null,
      } as FrameType,
      errors: (frame: Partial<FrameType>) => ({
        host: !frame.host ? 'Please enter a host' : null,
      }),
      submit: async (frame) => {
        try {
          const formData = new FormData()
          Object.keys(frame).forEach((key) => {
            formData.append(key, (frame as any)[key])
          })

          const response = await fetch('/api/frames/new', {
            method: 'POST',
            body: formData,
          })

          if (!response.ok) {
            throw new Error('Failed to submit frame')
          }

          actions.resetNewFrame()
        } catch (error) {
          console.error(error)
        }
      },
    },
  })),
])