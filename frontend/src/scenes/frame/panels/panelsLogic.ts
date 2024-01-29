import { actions, BuiltLogic, kea, key, listeners, path, props, reducers, selectors } from 'kea'
import { framesModel } from '../../../models/framesModel'
import equal from 'fast-deep-equal'
import { AppNodeData, Area, Panel, PanelWithMetadata } from '../../../types'

import type { panelsLogicType } from './panelsLogicType'

export interface PanelsLogicProps {
  frameId: number
}

export interface AnyBuiltLogic extends BuiltLogic {}

const DEFAULT_LAYOUT: Record<Area, PanelWithMetadata[]> = {
  [Area.TopLeft]: [{ panel: Panel.Diagram, active: true, hidden: false, metadata: { sceneId: 'default' } }],
  [Area.TopRight]: [
    { panel: Panel.Apps, active: true, hidden: false },
    { panel: Panel.Events, active: false, hidden: false },
    { panel: Panel.Scenes, active: false, hidden: false },
    { panel: Panel.Templates, active: false, hidden: false },
    { panel: Panel.FrameDetails, active: false, hidden: false },
    { panel: Panel.FrameSettings, active: false, hidden: false },
  ],
  [Area.BottomLeft]: [
    { panel: Panel.Logs, active: true, hidden: false },
    { panel: Panel.Metrics, active: false, hidden: false },
    { panel: Panel.Terminal, active: false, hidden: false },
    { panel: Panel.Debug, active: false, hidden: false },
    { panel: Panel.SceneSource, active: false, hidden: false },
  ],
  [Area.BottomRight]: [{ panel: Panel.Image, active: true, hidden: false }],
}

function panelsEqual(panel1: PanelWithMetadata, panel2: PanelWithMetadata) {
  return panel1.panel === panel2.panel && panel1.key === panel2.key
}

export const panelsLogic = kea<panelsLogicType>([
  path(['src', 'scenes', 'frame', 'panelsLogic']),
  props({} as PanelsLogicProps),
  key((props) => props.frameId),
  actions({
    setPanel: (area: Area, panel: PanelWithMetadata) => ({ area, panel }),
    closePanel: (panel: PanelWithMetadata) => ({ panel }),
    toggleFullScreenPanel: (panel: PanelWithMetadata) => ({ panel }),
    editApp: (sceneId: string, nodeId: string, nodeData: AppNodeData) => ({ sceneId, nodeId, nodeData }),
    persistUntilClosed: (panel: PanelWithMetadata, logic: AnyBuiltLogic) => ({ panel, logic }),
  }),
  reducers({
    panels: [
      DEFAULT_LAYOUT as Record<Area, PanelWithMetadata[]>,
      {
        setPanel: (state, { area, panel }) => {
          const newPanels = { ...state }
          newPanels[area] = newPanels[area].map((p) => ({
            ...p,
            active: panelsEqual(p, panel),
          }))
          return equal(state, newPanels) ? state : newPanels
        },
        closePanel: (state, { panel }) =>
          Object.fromEntries(
            Object.entries(state).map(([k, v]) => [k, v.filter((p) => !panelsEqual(p, panel))])
          ) as Record<Area, PanelWithMetadata[]>,
        editApp: (state, { sceneId, nodeId, nodeData }) => ({
          ...state,
          [Area.TopLeft]: state[Area.TopLeft].find((a) => a.panel === Panel.EditApp && a.key === `${sceneId}.${nodeId}`)
            ? state[Area.TopLeft].map((a) =>
                a.key === `${sceneId}.${nodeId}` ? { ...a, active: true } : a.active ? { ...a, active: false } : a
              )
            : [
                ...state[Area.TopLeft].map((a) => ({ ...a, active: false })),
                {
                  panel: Panel.EditApp,
                  key: `${sceneId}.${nodeId}`,
                  title: nodeData.name || nodeData.keyword || nodeId,
                  active: true,
                  hidden: false,
                  closable: true,
                  metadata: {
                    sceneId,
                    nodeId,
                    nodeData,
                  },
                },
              ],
        }),
      },
    ],
    fullScreenPanel: [
      null as PanelWithMetadata | null,
      {
        toggleFullScreenPanel: (state, { panel }) => (state && panelsEqual(state, panel) ? null : panel),
      },
    ],
  }),
  selectors(() => ({
    id: [() => [(_, props) => props.id], (id) => id],
    frame: [(s) => [framesModel.selectors.frames, s.id], (frames, id) => frames[id] || null],
    panelsWithConditions: [
      (s) => [s.panels, s.fullScreenPanel],
      (panels, fullScreenPanel): Record<Area, PanelWithMetadata[]> =>
        fullScreenPanel
          ? {
              [Area.TopLeft]: panels.TopLeft.filter((p) => panelsEqual(p, fullScreenPanel)),
              [Area.TopRight]: panels.TopRight.filter((p) => panelsEqual(p, fullScreenPanel)),
              [Area.BottomLeft]: panels.BottomLeft.filter((p) => panelsEqual(p, fullScreenPanel)),
              [Area.BottomRight]: panels.BottomRight.filter((p) => panelsEqual(p, fullScreenPanel)),
            }
          : panels,
    ],
  })),
  listeners(({ cache }) => ({
    persistUntilClosed: ({ panel, logic }) => {
      if (!cache.closeListeners) {
        cache.closeListeners = {} as Record<string, () => void>
      }
      if (!cache.closeListeners[`${panel.panel}.${panel.key}`]) {
        cache.closeListeners[`${panel.panel}.${panel.key}`] = logic.mount()
      }
    },
    closePanel: ({ panel }) => {
      if (cache.closeListeners && cache.closeListeners[`${panel.panel}.${panel.key}`]) {
        cache.closeListeners[`${panel.panel}.${panel.key}`]()
        delete cache.closeListeners[`${panel.panel}.${panel.key}`]
      }
    },
  })),
])
