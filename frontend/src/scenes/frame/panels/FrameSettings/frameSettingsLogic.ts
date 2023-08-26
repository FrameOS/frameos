import { actions, kea, key, listeners, path, props, reducers, selectors } from 'kea'
import { framesModel } from '../../../../models/framesModel'

import { forms } from 'kea-forms'
import { FrameType } from '../../../../types'

import type { frameSettingsLogicType } from './frameSettingsLogicType'

export interface DetailsLogicProps {
  id: number
}

export const frameSettingsLogic = kea<frameSettingsLogicType>([
  path(['src', 'scenes', 'frame', 'frameSettingsLogic']),
  props({} as DetailsLogicProps),
  key((props) => props.id),
  actions({
    editFrame: (frame: FrameType) => ({ frame }),
    closeEdit: true,
  }),
  selectors(() => ({
    id: [() => [(_, props) => props.id], (id) => id],
    frame: [(s) => [framesModel.selectors.frames, s.id], (frames, id) => frames[id] || null],
  })),
  forms(({ actions, values }) => ({
    editFrame: {
      defaults: {} as any as FrameType,
      submit: async (frame) => {
        try {
          const formData = new FormData()
          Object.keys(frame).forEach((key) => {
            const value = (frame as any)[key]
            formData.append(key, value === null || value === undefined ? '' : value)
          })
          const response = await fetch(`/api/frames/${values.id}/update`, {
            method: 'POST',
            body: formData,
          })
          if (!response.ok) {
            throw new Error('Failed to submit frame')
          }
          actions.resetEditFrame()
          actions.closeEdit()
        } catch (error) {
          console.error(error)
        }
      },
    },
  })),
  reducers({
    editing: [false, { editFrame: () => true, closeEdit: () => false }],
  }),
  listeners(({ actions }) => ({
    editFrame: async ({ frame }) => {
      actions.resetEditFrame()
      actions.setEditFrameValues({
        frame_host: frame.frame_host,
        frame_port: frame.frame_port,
        ssh_user: frame.ssh_user,
        ssh_pass: frame.ssh_pass,
        ssh_port: frame.ssh_port,
        server_host: frame.server_host,
        server_port: frame.server_port,
        server_api_key: frame.server_api_key,
        width: frame.width,
        height: frame.height,
        interval: frame.interval,
        scaling_mode: frame.scaling_mode,
        background_color: frame.background_color,
      })
    },
  })),
])
