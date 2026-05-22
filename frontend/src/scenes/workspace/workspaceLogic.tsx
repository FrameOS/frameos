import { actions, afterMount, connect, kea, listeners, path, reducers, selectors } from 'kea'
import { router } from 'kea-router'
import { framesModel } from '../../models/framesModel'
import { frameHost } from '../../decorators/frame'
import { FrameScene, FrameType } from '../../types'
import { urls } from '../../urls'
import type { workspaceLogicType } from './workspaceLogicType'

export type WorkspaceUtilityPanel =
  | 'overview'
  | 'state'
  | 'apps'
  | 'events'
  | 'templates'
  | 'scenes'
  | 'schedule'
  | 'logs'
  | 'metrics'
  | 'assets'
  | 'terminal'
  | 'settings'
  | 'source'
  | 'json'
  | 'preview'
  | 'ping'
  | 'debug'

export interface SceneSelection {
  frameId: number
  sceneId: string
}

export interface OverviewFrameSection {
  frame: FrameType
  scenes: FrameScene[]
  archived: boolean
  frameMatchesSearch: boolean
}

export interface WorkspaceSceneOption {
  frameId: number
  sceneId: string
  frameName: string
  sceneName: string
}

export type WorkspaceTheme = 'light' | 'dark'

function getInitialWorkspaceTheme(): WorkspaceTheme {
  if (typeof window === 'undefined') {
    return 'light'
  }
  const storedTheme = window.localStorage.getItem('frameos.workspaceTheme')
  if (storedTheme === 'light' || storedTheme === 'dark') {
    return storedTheme
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyWorkspaceTheme(theme: WorkspaceTheme): void {
  if (typeof document === 'undefined') {
    return
  }
  document.documentElement.dataset.frameosTheme = theme
  document.documentElement.style.colorScheme = theme
}

function sceneMatchesSearch(scene: FrameScene, search: string): boolean {
  if (!search) {
    return true
  }
  const text = [scene.name, scene.id, ...(scene.nodes ?? []).map((node) => `${node.type} ${node.id}`)]
    .join(' ')
    .toLowerCase()
  return text.includes(search)
}

function frameMatchesSearch(frame: FrameType, search: string): boolean {
  if (!search) {
    return true
  }
  return [frame.name, frameHost(frame), frame.frame_host, frame.status].join(' ').toLowerCase().includes(search)
}

function defaultSceneId(frame: FrameType | null | undefined): string | null {
  const scenes = frame?.scenes ?? []
  return scenes.find((scene) => scene.default)?.id ?? scenes[0]?.id ?? null
}

export const workspaceLogic = kea<workspaceLogicType>([
  path(['src', 'scenes', 'workspace', 'workspaceLogic']),
  connect(() => ({
    values: [framesModel, ['activeFramesList', 'archivedFramesList', 'framesList', 'frames']],
  })),
  actions({
    setSearch: (search: string) => ({ search }),
    setTheme: (theme: WorkspaceTheme) => ({ theme }),
    toggleTheme: true,
    openSecondarySidebar: true,
    toggleSecondarySidebar: true,
    toggleSceneNodesOpen: true,
    selectFrame: (frameId: number | null) => ({ frameId }),
    focusFrame: (frameId: number) => ({ frameId }),
    setRouteSelection: (frameId: number | null, sceneId: string | null = null) => ({ frameId, sceneId }),
    navigateToFrame: (frameId: number) => ({ frameId }),
    openFrameTool: (frameId: number, panel: WorkspaceUtilityPanel) => ({ frameId, panel }),
    navigateToSceneFrame: (frameId: number) => ({ frameId }),
    navigateToScene: (frameId: number, sceneId: string) => ({ frameId, sceneId }),
    openSceneControl: (frameId: number, sceneId: string) => ({ frameId, sceneId }),
    closeSceneControl: true,
    openUtilityPanel: (panel: WorkspaceUtilityPanel) => ({ panel }),
    closeUtilityPanel: true,
    selectNode: (nodeId: string | null) => ({ nodeId }),
  }),
  reducers({
    search: [
      '',
      {
        setSearch: (_, { search }) => search,
      },
    ],
    theme: [
      getInitialWorkspaceTheme(),
      {
        setTheme: (_, { theme }) => theme,
        toggleTheme: (theme) => (theme === 'dark' ? 'light' : 'dark'),
      },
    ],
    secondarySidebarOpen: [
      true,
      {
        openSecondarySidebar: () => true,
        toggleSecondarySidebar: (open) => !open,
      },
    ],
    sceneNodesOpen: [
      false,
      {
        toggleSceneNodesOpen: (open) => !open,
        navigateToScene: () => false,
        setRouteSelection: () => false,
      },
    ],
    selectedFrameId: [
      null as number | null,
      {
        selectFrame: (_, { frameId }) => frameId,
        focusFrame: (_, { frameId }) => frameId,
        setRouteSelection: (_, { frameId }) => frameId,
        openFrameTool: (_, { frameId }) => frameId,
      },
    ],
    selectedSceneIdsByFrame: [
      {} as Record<number, string>,
      {
        setRouteSelection: (state, { frameId, sceneId }) =>
          frameId && sceneId ? { ...state, [frameId]: sceneId } : state,
        navigateToScene: (state, { frameId, sceneId }) => ({ ...state, [frameId]: sceneId }),
      },
    ],
    sceneControlSelection: [
      null as SceneSelection | null,
      {
        openSceneControl: (_, { frameId, sceneId }) => ({ frameId, sceneId }),
        closeSceneControl: () => null,
        setSearch: () => null,
        navigateToFrame: () => null,
        openFrameTool: () => null,
        navigateToSceneFrame: () => null,
        navigateToScene: () => null,
        openUtilityPanel: () => null,
      },
    ],
    utilityPanel: [
      'state' as WorkspaceUtilityPanel | null,
      {
        openUtilityPanel: (_, { panel }) => panel,
        openFrameTool: (_, { panel }) => panel,
        closeUtilityPanel: () => null,
      },
    ],
    selectedNodeId: [
      null as string | null,
      {
        selectNode: (_, { nodeId }) => nodeId,
        navigateToScene: () => null,
        setRouteSelection: () => null,
      },
    ],
  }),
  selectors({
    selectedFrame: [
      (s) => [s.frames, s.selectedFrameId, s.activeFramesList, s.framesList],
      (frames, selectedFrameId, activeFramesList, framesList): FrameType | null => {
        if (selectedFrameId && frames[selectedFrameId]) {
          return frames[selectedFrameId]
        }
        return activeFramesList[0] ?? framesList[0] ?? null
      },
    ],
    selectedSceneId: [
      (s) => [s.selectedFrame, s.selectedSceneIdsByFrame],
      (selectedFrame, selectedSceneIdsByFrame): string | null => {
        if (!selectedFrame) {
          return null
        }
        const selectedSceneId = selectedSceneIdsByFrame[selectedFrame.id]
        if (selectedSceneId && selectedFrame.scenes?.some((scene) => scene.id === selectedSceneId)) {
          return selectedSceneId
        }
        return defaultSceneId(selectedFrame)
      },
    ],
    selectedScene: [
      (s) => [s.selectedFrame, s.selectedSceneId],
      (selectedFrame, selectedSceneId): FrameScene | null =>
        selectedFrame?.scenes?.find((scene) => scene.id === selectedSceneId) ?? null,
    ],
    filteredOverviewFrames: [
      (s) => [s.activeFramesList, s.search],
      (activeFramesList, search): FrameType[] => {
        const normalizedSearch = search.trim().toLowerCase()
        if (!normalizedSearch) {
          return activeFramesList
        }
        return activeFramesList.filter(
          (frame) =>
            frameMatchesSearch(frame, normalizedSearch) ||
            (frame.scenes ?? []).some((scene) => sceneMatchesSearch(scene, normalizedSearch))
        )
      },
    ],
    overviewFrameSections: [
      (s) => [s.activeFramesList, s.archivedFramesList, s.search],
      (activeFramesList, archivedFramesList, search): OverviewFrameSection[] => {
        const normalizedSearch = search.trim().toLowerCase()
        const frames = [
          ...activeFramesList.map((frame) => ({ frame, archived: false })),
          ...archivedFramesList.map((frame) => ({ frame, archived: true })),
        ]

        return frames
          .map(({ frame, archived }) => {
            const matchesFrame = frameMatchesSearch(frame, normalizedSearch)
            const scenes = normalizedSearch
              ? (frame.scenes ?? []).filter((scene) => sceneMatchesSearch(scene, normalizedSearch))
              : frame.scenes ?? []
            return { frame, scenes, archived, frameMatchesSearch: matchesFrame }
          })
          .filter(({ scenes, frameMatchesSearch }) => !normalizedSearch || frameMatchesSearch || scenes.length > 0)
      },
    ],
    filteredSelectedFrameScenes: [
      (s) => [s.selectedFrame, s.search],
      (selectedFrame, search): FrameScene[] => {
        const normalizedSearch = search.trim().toLowerCase()
        return (selectedFrame?.scenes ?? []).filter((scene) => sceneMatchesSearch(scene, normalizedSearch))
      },
    ],
    allSceneOptions: [
      (s) => [s.framesList],
      (framesList): WorkspaceSceneOption[] =>
        framesList.flatMap((frame) =>
          (frame.scenes ?? []).map((scene) => ({
            frameId: frame.id,
            sceneId: scene.id,
            frameName: frame.name || frameHost(frame),
            sceneName: scene.name || 'Untitled scene',
          }))
        ),
    ],
  }),
  listeners(({ actions, values }) => ({
    setTheme: ({ theme }) => {
      window.localStorage.setItem('frameos.workspaceTheme', theme)
      applyWorkspaceTheme(theme)
    },
    toggleTheme: () => {
      window.localStorage.setItem('frameos.workspaceTheme', values.theme)
      applyWorkspaceTheme(values.theme)
    },
    focusFrame: ({ frameId }) => {
      window.requestAnimationFrame(() => {
        document.getElementById(`workspace-frame-${frameId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    },
    navigateToFrame: ({ frameId }) => {
      actions.selectFrame(frameId)
      router.actions.push(urls.frame(frameId))
    },
    openFrameTool: ({ frameId }) => {
      router.actions.push(urls.frame(frameId))
    },
    navigateToSceneFrame: ({ frameId }) => {
      actions.selectFrame(frameId)
      router.actions.push(urls.scenes(frameId))
    },
    navigateToScene: ({ frameId, sceneId }) => {
      actions.setRouteSelection(frameId, sceneId)
      router.actions.push(urls.scenes(frameId, sceneId))
    },
  })),
  afterMount(({ values }) => {
    applyWorkspaceTheme(values.theme)
  }),
])
