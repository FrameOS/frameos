import { actions, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'
import { framesModel } from '../../models/framesModel'
import type { frameLogicType } from './frameLogicType'
import { subscriptions } from 'kea-subscriptions'
import { FrameScene, FrameType, TemplateType } from '../../types'
import { forms } from 'kea-forms'
import equal from 'fast-deep-equal'

export interface FrameLogicProps {
  id: number
}
const FRAME_KEYS = [
  'name',
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
  connect({ values: [framesModel, ['frames']] }),
  actions({
    updateScene: (sceneId: string, scene: Partial<FrameScene>) => ({ sceneId, scene }),
    updateNodeData: (sceneId: string, nodeId: string, nodeData: Record<string, any>) => ({ sceneId, nodeId, nodeData }),
    saveFrame: true,
    renderFrame: true,
    restartFrame: true,
    deployFrame: true,
    applyTemplate: (template: TemplateType) => ({ template }),
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
      null as 'render' | 'restart' | 'deploy' | null,
      {
        saveFrame: () => null,
        renderFrame: () => 'render',
        restartFrame: () => 'restart',
        deployFrame: () => 'deploy',
      },
    ],
  }),
  selectors(() => ({
    id: [() => [(_, props) => props.id], (id) => id],
    frame: [(s) => [s.frames, s.id], (frames, id) => frames[id] || null],
    frameChanged: [
      (s) => [s.frame, s.frameForm],
      (frame, frameForm) =>
        FRAME_KEYS.some((key) => !equal(frame?.[key as keyof FrameType], frameForm?.[key as keyof FrameType])),
    ],
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
  listeners(({ actions, values, props }) => ({
    renderFrame: () => framesModel.actions.renderFrame(props.id),
    saveFrame: () => actions.submitFrameForm(),
    deployFrame: () => actions.submitFrameForm(),
    restartFrame: () => actions.submitFrameForm(),
    updateScene: ({ sceneId, scene }) => {
      const { frame } = values
      const hasScene = frame.scenes?.some(({ id }) => id === sceneId)
      actions.setFrameFormValues({
        scenes: hasScene
          ? frame.scenes?.map((s) => (s.id === sceneId ? { ...s, ...scene } : s))
          : [...(frame.scenes ?? []), { ...scene, id: sceneId }],
      })
    },
    updateNodeData: ({ sceneId, nodeId, nodeData }) => {
      const { frame, frameForm } = values
      const scenes = frameForm.scenes ?? frame.scenes
      const scene = scenes?.find(({ id }) => id === sceneId)
      const currentNode = scene?.nodes?.find(({ id }) => id === nodeId)
      if (currentNode) {
        actions.setFrameFormValues({
          scenes: scenes?.map((s) =>
            s.id === sceneId
              ? {
                  ...s,
                  nodes: s.nodes?.map((n) =>
                    n.id === nodeId ? { ...n, data: { ...(n.data ?? {}), ...nodeData } } : n
                  ),
                }
              : s
          ),
        })
      } else {
        console.error(`Node ${nodeId} not found in scene ${sceneId}`)
      }
    },
    applyTemplate: ({ template }) => {
      actions.setFrameFormValues({
        ...('scenes' in template ? { scenes: template.scenes } : {}),
        ...('interval' in (template.config ?? {}) ? { interval: template.config?.interval } : {}),
        ...('scaling_mode' in (template.config ?? {}) ? { scaling_mode: template.config?.scaling_mode } : {}),
        ...('rotate' in (template.config ?? {}) ? { rotate: template.config?.rotate } : {}),
        ...('background_color' in (template.config ?? {})
          ? { background_color: template.config?.background_color }
          : {}),
      })
    },
  })),
])
