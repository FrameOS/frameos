import { actions, afterMount, BuiltLogic, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'
import { framesModel } from '../../../models/framesModel'
import equal from 'fast-deep-equal'
import { AppNodeData, Area, Panel, PanelWithMetadata } from '../../../types'

import type { panelsLogicType } from './panelsLogicType'
import { frameLogic } from '../frameLogic'

export interface PanelsLogicProps {
  frameId: number
}

export interface AnyBuiltLogic extends BuiltLogic {}

const DEFAULT_LAYOUT: Record<Area, PanelWithMetadata[]> = {
  [Area.TopLeft]: [{ panel: Panel.Scenes, active: false, hidden: false }],
  [Area.TopRight]: [
    { panel: Panel.Apps, active: true, hidden: false },
    { panel: Panel.Events, active: false, hidden: false },
    { panel: Panel.SceneState, active: false, hidden: false },
    { panel: Panel.FrameDetails, active: false, hidden: false },
    { panel: Panel.FrameSettings, active: false, hidden: false },
    { panel: Panel.Control, active: false, hidden: false },
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
  connect((props: PanelsLogicProps) => ({
    values: [frameLogic(props), ['defaultScene']],
  })),
  actions({
    setPanel: (area: Area, panel: PanelWithMetadata) => ({ area, panel }),
    openPanel: (panel: PanelWithMetadata) => ({ panel }),
    closePanel: (panel: PanelWithMetadata) => ({ panel }),
    toggleFullScreenPanel: (panel: PanelWithMetadata) => ({ panel }),
    editApp: (sceneId: string, nodeId: string, nodeData: AppNodeData) => ({ sceneId, nodeId, nodeData }),
    editScene: (sceneId: string) => ({ sceneId }),
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
        editScene: (state, { sceneId }) => ({
          ...state,
          [Area.TopLeft]: state[Area.TopLeft].find((a) => a.panel === Panel.Diagram && a.metadata?.sceneId === sceneId)
            ? state[Area.TopLeft].map((a) =>
                a.metadata?.sceneId === sceneId ? { ...a, active: true } : a.active ? { ...a, active: false } : a
              )
            : [
                ...state[Area.TopLeft].map((a) => ({ ...a, active: false })),
                {
                  panel: Panel.Diagram,
                  key: sceneId,
                  active: true,
                  hidden: false,
                  closable: true,
                  metadata: { sceneId },
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
    lastSelectedScene: [
      null as string | null,
      {
        openPanel: (state, { panel }) => (panel.panel === Panel.Diagram ? panel.key ?? state : state),
        setPanel: (state, { panel }) => (panel.panel === Panel.Diagram ? panel.key ?? state : state),
        editScene: (_, { sceneId }) => sceneId,
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
    selectedSceneId: [
      (s) => [s.frame, s.lastSelectedScene],
      (frame, lastSelectedScene): string | null =>
        lastSelectedScene ?? frame?.scenes?.find((s) => s.default)?.id ?? frame?.scenes?.[0]?.id ?? null,
    ],
    selectedSceneName: [
      (s) => [s.frame, s.selectedSceneId],
      (frame, selectedSceneId): string | null =>
        selectedSceneId ? frame?.scenes?.find((s) => s.id === selectedSceneId)?.name ?? null : null,
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
  afterMount(({ values, actions }) => {
    if (values.defaultScene) {
      actions.editScene(values.defaultScene)
    } else {
      const scenesPanel = values.panels[Area.TopRight].find((p) => p.panel === Panel.Scenes)
      if (scenesPanel) {
        actions.setPanel(Area.TopRight, scenesPanel)
      }
    }
  }),
])
