import { actions, afterMount, BuiltLogic, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'
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
    { panel: Panel.Templates, active: false, hidden: false },
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
    values: [frameLogic(props), ['defaultScene', 'frame', 'frameForm']],
    actions: [frameLogic(props), ['closeScenePanels']],
  })),
  actions({
    setPanel: (area: Area, panel: PanelWithMetadata) => ({ area, panel }),
    openPanel: (panel: PanelWithMetadata) => ({ panel }),
    closePanel: (panel: PanelWithMetadata) => ({ panel }),
    toggleFullScreenPanel: (panel: PanelWithMetadata) => ({ panel }),
    disableFullscreenPanel: true,
    editApp: (sceneId: string, nodeId: string, nodeData: AppNodeData) => ({ sceneId, nodeId, nodeData }),
    editScene: (sceneId: string) => ({ sceneId }),
    editStateScene: (sceneId: string) => ({ sceneId }),
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
        disableFullscreenPanel: () => null,
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
    lastSelectedStateScene: [
      null as string | null,
      {
        openPanel: (state, { panel }) =>
          panel.panel === Panel.Diagram || panel.panel === Panel.SceneState ? panel.key ?? state : state,
        setPanel: (state, { panel }) =>
          panel.panel === Panel.Diagram || panel.panel === Panel.SceneState ? panel.key ?? state : state,
        editScene: (_, { sceneId }) => sceneId,
        editStateScene: (_, { sceneId }) => sceneId,
      },
    ],
  }),
  selectors(() => ({
    id: [() => [(_, props) => props.id], (id) => id],
    panelsWithConditions: [
      (s) => [s.panels, s.fullScreenPanel],
      (panels, fullScreenPanel): Record<Area, PanelWithMetadata[]> => {
        if (!fullScreenPanel) {
          return panels
        }
        // we keep the full screen panel in the same area to not lose any mounted focus
        const topLeft = panels.TopLeft.filter((p) => panelsEqual(p, fullScreenPanel))
        const topRight = panels.TopRight.filter((p) => panelsEqual(p, fullScreenPanel))
        const bottomLeft = panels.BottomLeft.filter((p) => panelsEqual(p, fullScreenPanel))
        const bottomRight = panels.BottomRight.filter((p) => panelsEqual(p, fullScreenPanel))
        const goBack: PanelWithMetadata = {
          panel: Panel.Action,
          key: 'action:disableFullscreenPanel',
          active: false,
          hidden: false,
          closable: false,
          metadata: fullScreenPanel.metadata,
        }
        return {
          [Area.TopLeft]: [...(topLeft.length > 0 ? [goBack] : []), ...topLeft],
          [Area.TopRight]: [...(topRight.length > 0 ? [goBack] : []), ...topRight],
          [Area.BottomLeft]: [...(bottomLeft.length > 0 ? [goBack] : []), ...bottomLeft],
          [Area.BottomRight]: [...(bottomRight.length > 0 ? [goBack] : []), ...bottomRight],
        }
      },
    ],
    selectedSceneId: [
      (s) => [s.frameForm, s.lastSelectedScene],
      (frameForm, lastSelectedScene): string | null =>
        lastSelectedScene ?? frameForm?.scenes?.find((s) => s.default)?.id ?? frameForm?.scenes?.[0]?.id ?? null,
    ],
    selectedSceneName: [
      (s) => [s.frameForm, s.selectedSceneId],
      (frameForm, selectedSceneId): string | null =>
        selectedSceneId ? frameForm?.scenes?.find((s) => s.id === selectedSceneId)?.name ?? null : null,
    ],
    selectedStateSceneId: [
      (s) => [s.frameForm, s.lastSelectedStateScene],
      (frameForm, lastSelectedStateScene): string | null =>
        lastSelectedStateScene ?? frameForm?.scenes?.find((s) => s.default)?.id ?? frameForm?.scenes?.[0]?.id ?? null,
    ],
  })),
  listeners(({ actions, cache }) => ({
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
    closeScenePanels: ({ sceneIds }) => {
      for (const sceneId of sceneIds) {
        actions.closePanel({ panel: Panel.Diagram, key: sceneId })
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
