import { actions, afterMount, connect, kea, listeners, path, reducers, selectors } from 'kea'
import { router, urlToAction } from 'kea-router'
import { framesModel } from '../../models/framesModel'
import { frameHost, frameIsStale } from '../../decorators/frame'
import { FrameScene, FrameType } from '../../types'
import { urls } from '../../urls'
import { newFrameForm } from '../frames/newFrameForm'
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

const frameToolPanels = [
  'overview',
  'preview',
  'scenes',
  'logs',
  'metrics',
  'assets',
  'terminal',
  'ping',
  'debug',
  'settings',
] as const satisfies readonly WorkspaceUtilityPanel[]

function isFrameToolPanel(panel: unknown): panel is (typeof frameToolPanels)[number] {
  return typeof panel === 'string' && (frameToolPanels as readonly string[]).includes(panel)
}

function searchValue(search: Record<string, unknown>, key: string): string | null {
  const value = search[key]
  if (typeof value === 'string') {
    return value
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0]
  }
  return null
}

function frameToolFromSearch(search: Record<string, unknown>): WorkspaceUtilityPanel {
  const tool = searchValue(search, 'tool')
  return isFrameToolPanel(tool) ? tool : 'overview'
}

export interface SceneSelection {
  frameId: number
  sceneId: string
}

export interface ChatDrawerSelection {
  frameId: number
  sceneId: string | null
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

interface FramesScrollAnchor {
  frameId: string
  top: number
}

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

function frameIsActiveForHome(frame: FrameType): boolean {
  return frame.status === 'ready' && !frameIsStale(frame)
}

function frameIsActiveInSnapshot(
  frame: FrameType,
  frameActiveSnapshot: Record<number, boolean>,
  hasFrameOrderSnapshot: boolean
): boolean {
  if (!hasFrameOrderSnapshot) {
    return frameIsActiveForHome(frame)
  }
  return frameActiveSnapshot[frame.id] === true
}

function frameSortName(frame: FrameType): string {
  return (frame.name || frameHost(frame)).trim()
}

function compareFramesForHome(first: FrameType, second: FrameType): number {
  const firstActive = frameIsActiveForHome(first) ? 1 : 0
  const secondActive = frameIsActiveForHome(second) ? 1 : 0

  return (
    secondActive - firstActive ||
    frameSortName(first).localeCompare(frameSortName(second), undefined, { numeric: true, sensitivity: 'base' }) ||
    first.id - second.id
  )
}

function rankFramesForSnapshot(frames: FrameType[]): FrameType[] {
  return [...frames].sort(compareFramesForHome)
}

function applyFrameOrderSnapshot(frames: FrameType[], frameOrderSnapshot: number[]): FrameType[] {
  if (frameOrderSnapshot.length === 0) {
    return rankFramesForSnapshot(frames)
  }

  const order = new Map(frameOrderSnapshot.map((frameId, index) => [frameId, index]))
  return [...frames].sort((first, second) => {
    const firstIndex = order.get(first.id) ?? Number.MAX_SAFE_INTEGER
    const secondIndex = order.get(second.id) ?? Number.MAX_SAFE_INTEGER
    return firstIndex - secondIndex || compareFramesForHome(first, second)
  })
}

function framesMainElement(): HTMLElement | null {
  if (typeof document === 'undefined') {
    return null
  }
  return document.querySelector<HTMLElement>('[data-workspace-main="frames"]')
}

function frameTitleElement(frameId: string): HTMLElement | null {
  if (typeof document === 'undefined') {
    return null
  }
  return (
    Array.from(document.querySelectorAll<HTMLElement>('[data-workspace-frame-title]')).find(
      (title) => title.dataset.workspaceFrameTitle === frameId
    ) ?? null
  )
}

function captureFramesScrollAnchor(): FramesScrollAnchor | null {
  const main = framesMainElement()
  if (!main) {
    return null
  }

  const mainRect = main.getBoundingClientRect()
  const sections = Array.from(document.querySelectorAll<HTMLElement>('[data-workspace-frame-section]'))
  const candidates = sections
    .map((section) => {
      const frameId = section.dataset.workspaceFrameSection
      const title = frameId ? frameTitleElement(frameId) : null
      return {
        frameId,
        section,
        sectionRect: section.getBoundingClientRect(),
        title,
        titleRect: title?.getBoundingClientRect() ?? section.getBoundingClientRect(),
      }
    })
    .filter(
      (
        candidate
      ): candidate is {
        frameId: string
        section: HTMLElement
        sectionRect: DOMRect
        title: HTMLElement | null
        titleRect: DOMRect
      } =>
        Boolean(candidate.frameId) &&
        candidate.sectionRect.bottom >= mainRect.top &&
        candidate.sectionRect.top <= mainRect.bottom
    )

  if (candidates.length === 0) {
    return null
  }

  const visibleTitle = candidates
    .filter((candidate) => candidate.titleRect.bottom >= mainRect.top && candidate.titleRect.top <= mainRect.bottom)
    .toSorted((first, second) => first.titleRect.top - second.titleRect.top)[0]

  const activeFrame =
    visibleTitle ??
    candidates
      .filter((candidate) => candidate.sectionRect.top <= mainRect.top && candidate.sectionRect.bottom >= mainRect.top)
      .toSorted((first, second) => second.sectionRect.top - first.sectionRect.top)[0] ??
    candidates.toSorted(
      (first, second) =>
        Math.abs(first.sectionRect.top - mainRect.top) - Math.abs(second.sectionRect.top - mainRect.top)
    )[0]

  return activeFrame ? { frameId: activeFrame.frameId, top: activeFrame.titleRect.top } : null
}

function restoreFramesScrollAnchor(anchor: FramesScrollAnchor | null): void {
  if (!anchor) {
    return
  }
  const main = framesMainElement()
  const title = frameTitleElement(anchor.frameId)
  if (!main || !title) {
    return
  }
  const nextTop = title.getBoundingClientRect().top
  main.scrollTop += nextTop - anchor.top
}

function preserveFramesScrollAfterLayoutChange(cache: Record<string, any>): void {
  const anchor = captureFramesScrollAnchor()
  if (!anchor || typeof window === 'undefined') {
    return
  }

  if (cache.framesScrollAnchorFrame) {
    window.cancelAnimationFrame(cache.framesScrollAnchorFrame)
  }
  if (cache.framesScrollAnchorNestedFrame) {
    window.cancelAnimationFrame(cache.framesScrollAnchorNestedFrame)
  }

  cache.framesScrollAnchorFrame = window.requestAnimationFrame(() => {
    cache.framesScrollAnchorNestedFrame = window.requestAnimationFrame(() => {
      restoreFramesScrollAnchor(anchor)
      cache.framesScrollAnchorFrame = null
      cache.framesScrollAnchorNestedFrame = null
    })
  })
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
    openPrimarySidebar: true,
    collapsePrimarySidebar: true,
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
    openTemplateDrawer: (frameId: number) => ({ frameId }),
    closeTemplateDrawer: true,
    openScheduleDrawer: (frameId: number) => ({ frameId }),
    closeScheduleDrawer: true,
    openChatDrawer: (frameId: number, sceneId: string | null = null) => ({ frameId, sceneId }),
    closeChatDrawer: true,
    openUtilityPanel: (panel: WorkspaceUtilityPanel) => ({ panel }),
    closeUtilityPanel: true,
    selectNode: (nodeId: string | null) => ({ nodeId }),
    snapshotFrameOrder: true,
    setFrameOrderSnapshot: (frameIds: number[], activeFrameIds: number[]) => ({ frameIds, activeFrameIds }),
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
    primarySidebarOpen: [
      true,
      {
        openPrimarySidebar: () => true,
        collapsePrimarySidebar: () => false,
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
        openTemplateDrawer: () => null,
        openScheduleDrawer: () => null,
      },
    ],
    templateDrawerFrameId: [
      null as number | null,
      {
        openTemplateDrawer: (_, { frameId }) => frameId,
        closeTemplateDrawer: () => null,
        setSearch: () => null,
        navigateToFrame: () => null,
        openFrameTool: () => null,
        navigateToSceneFrame: () => null,
        navigateToScene: () => null,
        openSceneControl: () => null,
        openScheduleDrawer: () => null,
        openUtilityPanel: (state, { panel }) => (panel === 'scenes' ? state : null),
      },
    ],
    scheduleDrawerFrameId: [
      null as number | null,
      {
        openScheduleDrawer: (_, { frameId }) => frameId,
        closeScheduleDrawer: () => null,
        setSearch: () => null,
        navigateToFrame: () => null,
        openFrameTool: () => null,
        navigateToSceneFrame: () => null,
        navigateToScene: () => null,
        openTemplateDrawer: () => null,
        openSceneControl: () => null,
      },
    ],
    chatDrawerSelection: [
      null as ChatDrawerSelection | null,
      {
        openChatDrawer: (_, { frameId, sceneId }) => ({ frameId, sceneId }),
        closeChatDrawer: () => null,
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
    frameOrderSnapshot: [
      [] as number[],
      {
        setFrameOrderSnapshot: (_, { frameIds }) => frameIds,
      },
    ],
    frameActiveSnapshot: [
      {} as Record<number, boolean>,
      {
        setFrameOrderSnapshot: (_, { activeFrameIds }) =>
          Object.fromEntries(activeFrameIds.map((frameId: number) => [frameId, true])),
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
    orderedActiveFramesList: [
      (s) => [s.activeFramesList, s.frameOrderSnapshot],
      (activeFramesList, frameOrderSnapshot): FrameType[] =>
        applyFrameOrderSnapshot(activeFramesList, frameOrderSnapshot),
    ],
    orderedArchivedFramesList: [
      (s) => [s.archivedFramesList, s.frameOrderSnapshot],
      (archivedFramesList, frameOrderSnapshot): FrameType[] =>
        applyFrameOrderSnapshot(archivedFramesList, frameOrderSnapshot),
    ],
    homeActiveFramesList: [
      (s) => [s.orderedActiveFramesList, s.frameActiveSnapshot, s.frameOrderSnapshot],
      (orderedActiveFramesList, frameActiveSnapshot, frameOrderSnapshot): FrameType[] =>
        orderedActiveFramesList.filter((frame) =>
          frameIsActiveInSnapshot(frame, frameActiveSnapshot, frameOrderSnapshot.length > 0)
        ),
    ],
    homeInactiveFramesList: [
      (s) => [s.orderedActiveFramesList, s.frameActiveSnapshot, s.frameOrderSnapshot],
      (orderedActiveFramesList, frameActiveSnapshot, frameOrderSnapshot): FrameType[] =>
        orderedActiveFramesList.filter(
          (frame) => !frameIsActiveInSnapshot(frame, frameActiveSnapshot, frameOrderSnapshot.length > 0)
        ),
    ],
    filteredOverviewFrames: [
      (s) => [s.orderedActiveFramesList, s.search],
      (orderedActiveFramesList, search): FrameType[] => {
        const normalizedSearch = search.trim().toLowerCase()
        if (!normalizedSearch) {
          return orderedActiveFramesList
        }
        return orderedActiveFramesList.filter(
          (frame) =>
            frameMatchesSearch(frame, normalizedSearch) ||
            (frame.scenes ?? []).some((scene) => sceneMatchesSearch(scene, normalizedSearch))
        )
      },
    ],
    overviewFrameSections: [
      (s) => [s.orderedActiveFramesList, s.orderedArchivedFramesList, s.search],
      (orderedActiveFramesList, orderedArchivedFramesList, search): OverviewFrameSection[] => {
        const normalizedSearch = search.trim().toLowerCase()
        const frames = [
          ...orderedActiveFramesList.map((frame) => ({ frame, archived: false })),
          ...orderedArchivedFramesList.map((frame) => ({ frame, archived: true })),
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
    overviewActiveFrameSections: [
      (s) => [s.overviewFrameSections, s.frameActiveSnapshot, s.frameOrderSnapshot],
      (overviewFrameSections, frameActiveSnapshot, frameOrderSnapshot): OverviewFrameSection[] =>
        overviewFrameSections.filter(
          (section) =>
            !section.archived &&
            frameIsActiveInSnapshot(section.frame, frameActiveSnapshot, frameOrderSnapshot.length > 0)
        ),
    ],
    overviewInactiveFrameSections: [
      (s) => [s.overviewFrameSections, s.frameActiveSnapshot, s.frameOrderSnapshot],
      (overviewFrameSections, frameActiveSnapshot, frameOrderSnapshot): OverviewFrameSection[] =>
        overviewFrameSections.filter(
          (section) =>
            !section.archived &&
            !frameIsActiveInSnapshot(section.frame, frameActiveSnapshot, frameOrderSnapshot.length > 0)
        ),
    ],
    overviewArchivedFrameSections: [
      (s) => [s.overviewFrameSections],
      (overviewFrameSections): OverviewFrameSection[] => overviewFrameSections.filter((section) => section.archived),
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
  listeners(({ actions, cache, values }) => {
    const preserveFramesScroll = () => preserveFramesScrollAfterLayoutChange(cache)

    return {
      openSceneControl: preserveFramesScroll,
      closeSceneControl: preserveFramesScroll,
      openTemplateDrawer: preserveFramesScroll,
      closeTemplateDrawer: preserveFramesScroll,
      openScheduleDrawer: preserveFramesScroll,
      closeScheduleDrawer: preserveFramesScroll,
      openChatDrawer: preserveFramesScroll,
      closeChatDrawer: preserveFramesScroll,
      [newFrameForm.actionTypes.showForm]: preserveFramesScroll,
      [newFrameForm.actionTypes.hideForm]: preserveFramesScroll,
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
        const panel = isFrameToolPanel(values.utilityPanel) ? values.utilityPanel : 'overview'
        router.actions.push(urls.frame(frameId, panel))
      },
      openFrameTool: ({ frameId, panel }) => {
        router.actions.push(urls.frame(frameId, panel))
      },
      navigateToSceneFrame: ({ frameId }) => {
        actions.selectFrame(frameId)
        router.actions.push(urls.scenes(frameId))
      },
      navigateToScene: ({ frameId, sceneId }) => {
        actions.setRouteSelection(frameId, sceneId)
        router.actions.push(urls.scenes(frameId, sceneId))
      },
      snapshotFrameOrder: () => {
        const rankedFrames = rankFramesForSnapshot(values.framesList)
        actions.setFrameOrderSnapshot(
          rankedFrames.map((frame) => frame.id),
          rankedFrames.filter(frameIsActiveForHome).map((frame) => frame.id)
        )
      },
    }
  }),
  urlToAction(({ actions }) => ({
    [urls.frame(':id')]: ({ id }, search) => {
      const frameId = parseInt(String(id), 10)
      if (Number.isFinite(frameId)) {
        actions.selectFrame(frameId)
      }
      if (Number.isFinite(frameId) && searchValue(search, 'tool') === 'schedule') {
        actions.openUtilityPanel('scenes')
        actions.openScheduleDrawer(frameId)
        return
      }
      actions.openUtilityPanel(frameToolFromSearch(search))
    },
  })),
  afterMount(({ values }) => {
    applyWorkspaceTheme(values.theme)
  }),
])
