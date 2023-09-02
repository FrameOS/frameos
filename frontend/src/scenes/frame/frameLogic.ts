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
  'background_color',
  'scenes',
]

const DEFAULT_LAYOUT: Record<Area, PanelWithMetadata[]> = {
  [Area.TopLeft]: [{ panel: Panel.Diagram, active: true, hidden: false, metadata: { sceneId: 'default' } }],
  [Area.TopRight]: [
    { panel: Panel.Apps, active: true, hidden: false },
    { panel: Panel.Events, active: true, hidden: false },
    { panel: Panel.FrameDetails, active: false, hidden: false },
    { panel: Panel.FrameSettings, active: false, hidden: false },
  ],
  [Area.BottomLeft]: [{ panel: Panel.Logs, active: true, hidden: false }],
  [Area.BottomRight]: [{ panel: Panel.Image, active: true, hidden: false }],
}
export const frameLogic = kea<frameLogicType>([
  path(['src', 'scenes', 'frame', 'frameLogic']),
  props({} as FrameLogicProps),
  key((props) => props.id),
  actions({
    setPanel: (area: Area, panel: string, label?: string) => ({ area, panel, label }),
    toggleFullScreenPanel: (panel: Panel) => ({ panel }),
    updateScene: (sceneId: string, scene: any) => ({ sceneId, scene }),
    saveFrame: true,
    refreshFrame: true,
    restartFrame: true,
    redeployFrame: true,
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
          } else {
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
    panels: [
      DEFAULT_LAYOUT as Record<Area, PanelWithMetadata[]>,
      {
        setPanel: (state, { area, panel, label }) => {
          const newPanels = { ...state }
          newPanels[area] = newPanels[area].map((p) => ({
            ...p,
            active: p.panel === panel,
            label: p.panel === panel && label ? label : p.label,
          }))
          return equal(state, newPanels) ? state : newPanels
        },
      },
    ],
    fullScreenPanel: [
      null as Panel | null,
      {
        toggleFullScreenPanel: (state, { panel }) => (state === panel ? null : panel),
      },
    ],
  }),
  selectors(() => ({
    id: [() => [(_, props) => props.id], (id) => id],
    frame: [(s) => [framesModel.selectors.frames, s.id], (frames, id) => frames[id] || null],
    panelsWithConditions: [
      (s) => [s.panels, () => null, s.fullScreenPanel], // s.selectedNode
      (panels, selectedNode, fullScreenPanel): Record<Area, PanelWithMetadata[]> =>
        fullScreenPanel
          ? {
              [Area.TopLeft]: [{ panel: fullScreenPanel, active: true, hidden: false }],
              [Area.TopRight]: [],
              [Area.BottomLeft]: [],
              [Area.BottomRight]: [],
            }
          : panels,
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
  listeners(({ actions }) => ({
    saveFrame: () => actions.submitFrameForm(),
    refreshFrame: () => actions.submitFrameForm(),
    redeployFrame: () => actions.submitFrameForm(),
    restartFrame: () => actions.submitFrameForm(),
  })),
])
