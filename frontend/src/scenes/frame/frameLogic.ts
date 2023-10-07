import { actions, kea, key, listeners, path, props, reducers, selectors } from 'kea'
import { framesModel } from '../../models/framesModel'
import equal from 'fast-deep-equal'
import type { frameLogicType } from './frameLogicType'
import { subscriptions } from 'kea-subscriptions'
import { Area, FrameType, Panel, PanelWithMetadata } from '../../types'
import { forms } from 'kea-forms'

export interface FrameLogicProps {
  id: number
}
const FRAME_KEYS = [
  'frame_host',
  'frame_port',
  'ssh_user',
  'ssh_pass',
  'ssh_port',
  'server_host',
  'server_port',
  'server_api_key',
  'width',
  'height',
  'color',
  'device',
  'interval',
  'scaling_mode',
  'rotate',
  'background_color',
  'scenes',
]

export const frameLogic = kea<frameLogicType>([
  path(['src', 'scenes', 'frame', 'frameLogic']),
  props({} as FrameLogicProps),
  key((props) => props.id),
  actions({
    updateScene: (sceneId: string, scene: any) => ({ sceneId, scene }),
    saveFrame: true,
    refreshFrame: true,
    restartFrame: true,
    redeployFrame: true,
    updateNodeSource: (sceneId: string, nodeId: string, file: string, source: string) => ({
      sceneId,
      nodeId,
      file,
      source,
    }),
  }),
  forms(({ actions, values }) => ({
    frameForm: {
      options: {
        showErrorsOnTouch: true,
      },
      defaults: {} as FrameType,
      submit: async (frame, breakpoint) => {
        const formData = new FormData()
        for (const key of FRAME_KEYS) {
          const value = frame[key as keyof typeof frame]
          if (typeof value === 'string') {
            formData.append(key, value)
          } else if (value !== undefined && value !== null) {
            formData.append(key, JSON.stringify(frame[key as keyof typeof frame]))
          }
        }
        if (values.nextAction) {
          formData.append('next_action', values.nextAction)
        }
        const response = await fetch(`/api/frames/${values.id}`, {
          method: 'POST',
          body: formData,
        })
        if (!response.ok) {
          throw new Error('Failed to update frame')
        }
      },
    },
  })),

  reducers({
    currentScene: ['default', {}],
    nextAction: [
      null as string | null,
      {
        saveFrame: () => null,
        refreshFrame: () => 'refresh',
        restartFrame: () => 'restart',
        redeployFrame: () => 'redeploy',
      },
    ],
  }),
  selectors(() => ({
    id: [() => [(_, props) => props.id], (id) => id],
    frame: [(s) => [framesModel.selectors.frames, s.id], (frames, id) => frames[id] || null],
  })),
  subscriptions(({ actions }) => ({
    frame: (frame, oldFrame) => {
      if (frame) {
        if (FRAME_KEYS.some((key) => JSON.stringify(frame[key]) !== JSON.stringify(oldFrame?.[key]))) {
          actions.resetFrameForm(frame)
        }
      }
    },
  })),
  listeners(({ actions }) => ({
    saveFrame: () => actions.submitFrameForm(),
    refreshFrame: () => actions.submitFrameForm(),
    redeployFrame: () => actions.submitFrameForm(),
    restartFrame: () => actions.submitFrameForm(),
  })),
])
