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

const DEFAULT_LAYOUT: Record<Area, PanelWithMetadata[]> = {
  [Area.TopLeft]: [{ panel: Panel.Diagram, active: true, hidden: false, metadata: { sceneId: 'default' } }],
  [Area.TopRight]: [
    { panel: Panel.AddApps, active: true, hidden: false },
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
        formData.append('scenes', JSON.stringify(frame.scenes))
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
      errors: (frame) => {
        // const newArray: Partial<AppConfig>[] = appsArray
        //   .map((AppConfig) => {
        //     const app = appsModel.values.apps[AppConfig.keyword]
        //     if (!app) {
        //       return null
        //     }
        //     return {
        //       config: Object.fromEntries(
        //         app?.fields
        //           ?.filter(({ name, required }) => required && !AppConfig.config[name])
        //           .map(({ name }) => [name, 'This field is required'])
        //       ),
        //     }
        //   })
        //   .filter((a): a is AppConfig => !!a)
        // return {
        //   appsArray: newArray,
        // }\
        return {}
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
    frame: (value, oldValue) => {
      if (value && JSON.stringify(value.scenes) !== JSON.stringify(oldValue?.scenes)) {
        actions.resetFrameForm(value)
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
