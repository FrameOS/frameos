import { actions, afterMount, kea, listeners, path, reducers, selectors } from 'kea'

import { forms } from 'kea-forms'
import { FrameType } from '../../types'

import type { newFrameFormType } from './newFrameFormType'

export const newFrameForm = kea<newFrameFormType>([
  path(['src', 'scenes', 'frames', 'newFrameForm']),
  forms(({ actions }) => ({
    newFrame: {
      defaults: {
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
