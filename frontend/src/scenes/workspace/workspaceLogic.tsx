import { actions, afterMount, connect, events, kea, listeners, path, reducers, selectors } from 'kea'
import { actionToUrl, router, urlToAction } from 'kea-router'
import { framesModel } from '../../models/framesModel'
import { frameHost, frameIsActive } from '../../decorators/frame'
import { FrameScene, FrameType } from '../../types'
import { urls } from '../../urls'
import { applyFrameosTheme } from '../../utils/frameosTheme'
import { DeployDrawerView, frameLogic } from '../frame/frameLogic'
import { newFrameForm } from '../frames/newFrameForm'
import type { workspaceLogicType } from './workspaceLogicType'

export type WorkspaceUtilityPanel =
  | 'overview'
  | 'info'
  | 'state'
  | 'stateVariables'
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
  'schedule',
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

function searchNumberValue(search: Record<string, unknown>, key: string): number | null {
  const value = search[key]
  const candidate = Array.isArray(value) ? value[0] : value
  if (typeof candidate === 'number') {
    return Number.isFinite(candidate) ? candidate : null
  }
  if (typeof candidate === 'string') {
    const parsed = Number(candidate)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function frameToolFromSearch(search: Record<string, unknown>): WorkspaceUtilityPanel {
  const tool = searchValue(search, 'tool')
  return isFrameToolPanel(tool) ? tool : 'overview'
}

export function frameToolScrollKey(frameId: number, panel: WorkspaceUtilityPanel): string {
  return `${frameId}:${panel}`
}

export function frameAssetFolderExpansionKey(frameId: number, path: string): string {
  return `${frameId}:${path}`
}

function drawerFrameIdFromSearch(search: Record<string, unknown>): number | null {
  return searchNumberValue(search, 'frameId')
}

function clearDrawerSearchParams(search: Record<string, unknown>): Record<string, unknown> {
  const nextSearch = { ...search }
  delete nextSearch.drawer
  delete nextSearch.frameId
  delete nextSearch.sceneId
  delete nextSearch.nodeId
  return nextSearch
}

function framesRoutePath(): string {
  return urls.frames() || '/'
}

function isFramesRoutePath(pathname: string): boolean {
  const framesPath = framesRoutePath()
  return pathname === framesPath || pathname === `${framesPath}/`
}

function isFrameRoutePathForFrame(pathname: string, frameId: number): boolean {
  return pathname === urls.frame(frameId)
}

function isWorkspaceRoutePathForFrame(pathname: string, frameId: number): boolean {
  const scenePath = urls.scenes(frameId)
  const appPath = urls.apps(frameId)
  return (
    pathname === scenePath ||
    pathname.startsWith(`${scenePath}/`) ||
    pathname === appPath ||
    pathname.startsWith(`${appPath}/`)
  )
}

function pathNumberAfterToken(pathname: string, tokenizedPath: string, token: string): number | null {
  const tokenIndex = tokenizedPath.indexOf(token)
  if (tokenIndex === -1) {
    return null
  }
  const prefix = tokenizedPath.slice(0, tokenIndex)
  if (!pathname.startsWith(prefix)) {
    return null
  }
  const rawValue = pathname.slice(prefix.length).split('/')[0]
  const parsedValue = Number(rawValue)
  return Number.isFinite(parsedValue) ? parsedValue : null
}

function frameIdFromWorkspacePath(pathname: string): number | null {
  return (
    pathNumberAfterToken(pathname, urls.frame(':frameId'), ':frameId') ??
    pathNumberAfterToken(pathname, urls.scenes(':frameId'), ':frameId') ??
    pathNumberAfterToken(pathname, urls.apps(':frameId'), ':frameId')
  )
}

function drawerPathForFrame(frameId: number): string {
  const pathname = router.values.location.pathname
  if (
    isFramesRoutePath(pathname) ||
    isFrameRoutePathForFrame(pathname, frameId) ||
    isWorkspaceRoutePathForFrame(pathname, frameId)
  ) {
    return pathname
  }
  return urls.frame(frameId)
}

function drawerUrlForFrame(
  frameId: number,
  drawer: string,
  extraSearch: Record<string, unknown> = {}
): [string, Record<string, unknown>, Record<string, unknown>] {
  const pathname = drawerPathForFrame(frameId)
  const search: Record<string, unknown> = {
    ...clearDrawerSearchParams(router.values.searchParams),
    drawer,
    ...extraSearch,
  }
  if (!isFrameRoutePathForFrame(pathname, frameId)) {
    search.frameId = String(frameId)
  }
  return [pathname, search, utilityDrawerClosedHash()]
}

function clearDrawerUrl(): [string, Record<string, unknown>, Record<string, unknown>] {
  return [
    router.values.location.pathname,
    clearDrawerSearchParams(router.values.searchParams),
    router.values.hashParams,
  ]
}

export interface SceneSelection {
  frameId: number
  sceneId: string
}

export interface ChatDrawerSelection {
  frameId: number
  sceneId: string | null
  nodeId?: string | null
}

export interface FrameRenameDialog {
  frameId: number
  name: string
}

export type FrameChangeDrawerKind = 'unsaved' | 'deploy'

export interface FrameChangeDrawerSelection {
  frameId: number
  kind: FrameChangeDrawerKind
  deployDrawerView?: DeployDrawerView
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

let nextFramesRouteScrollIntent: 'top' | null = null

export function requestNextFramesHomeScrollTop(): void {
  nextFramesRouteScrollIntent = 'top'
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

const MOBILE_WORKSPACE_MEDIA_QUERY = '(max-width: 1023px)'
const SECONDARY_SIDEBAR_HASH_KEY = 'workspaceSidebar'
const SECONDARY_SIDEBAR_HASH_VALUE = 'open'
const UTILITY_DRAWER_HASH_KEY = 'workspaceDrawer'
const WORKSPACE_SCROLL_LOCK_CLASS = 'frameos-workspace-scroll-locked'
const sceneUtilityPanels = [
  'state',
  'stateVariables',
  'apps',
  'events',
  'source',
  'json',
  'info',
] as const satisfies readonly WorkspaceUtilityPanel[]

type SceneUtilityPanel = (typeof sceneUtilityPanels)[number]

const sceneUtilityPanelHashValues: Record<SceneUtilityPanel, string> = {
  state: 'preview',
  stateVariables: 'stateVariables',
  apps: 'apps',
  events: 'events',
  source: 'source',
  json: 'json',
  info: 'info',
}

export function isMobileWorkspaceViewport(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.(MOBILE_WORKSPACE_MEDIA_QUERY).matches
}

function applyWorkspaceScrollGuard(locked: boolean): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return
  }

  const body = document.body
  const root = document.documentElement
  const shouldLock = locked && isMobileWorkspaceViewport()

  if (shouldLock) {
    if (body.dataset.frameosWorkspaceScrollLocked === 'true') {
      return
    }

    body.dataset.frameosWorkspaceScrollLocked = 'true'
    body.dataset.frameosWorkspaceScrollX = String(window.scrollX)
    body.dataset.frameosWorkspaceScrollY = String(window.scrollY)
    body.dataset.frameosWorkspaceBodyPosition = body.style.position
    body.dataset.frameosWorkspaceBodyTop = body.style.top
    body.dataset.frameosWorkspaceBodyLeft = body.style.left
    body.dataset.frameosWorkspaceBodyRight = body.style.right
    body.dataset.frameosWorkspaceBodyWidth = body.style.width
    body.dataset.frameosWorkspaceBodyOverflow = body.style.overflow

    root.classList.add(WORKSPACE_SCROLL_LOCK_CLASS)
    body.classList.add(WORKSPACE_SCROLL_LOCK_CLASS)
    body.style.position = 'fixed'
    body.style.top = `-${window.scrollY}px`
    body.style.left = '0'
    body.style.right = '0'
    body.style.width = '100%'
    body.style.overflow = 'hidden'
    return
  }

  root.classList.remove(WORKSPACE_SCROLL_LOCK_CLASS)
  body.classList.remove(WORKSPACE_SCROLL_LOCK_CLASS)

  if (body.dataset.frameosWorkspaceScrollLocked !== 'true') {
    return
  }

  const scrollX = Number(body.dataset.frameosWorkspaceScrollX ?? '0')
  const scrollY = Number(body.dataset.frameosWorkspaceScrollY ?? '0')
  body.style.position = body.dataset.frameosWorkspaceBodyPosition ?? ''
  body.style.top = body.dataset.frameosWorkspaceBodyTop ?? ''
  body.style.left = body.dataset.frameosWorkspaceBodyLeft ?? ''
  body.style.right = body.dataset.frameosWorkspaceBodyRight ?? ''
  body.style.width = body.dataset.frameosWorkspaceBodyWidth ?? ''
  body.style.overflow = body.dataset.frameosWorkspaceBodyOverflow ?? ''

  delete body.dataset.frameosWorkspaceScrollLocked
  delete body.dataset.frameosWorkspaceScrollX
  delete body.dataset.frameosWorkspaceScrollY
  delete body.dataset.frameosWorkspaceBodyPosition
  delete body.dataset.frameosWorkspaceBodyTop
  delete body.dataset.frameosWorkspaceBodyLeft
  delete body.dataset.frameosWorkspaceBodyRight
  delete body.dataset.frameosWorkspaceBodyWidth
  delete body.dataset.frameosWorkspaceBodyOverflow

  window.scrollTo(Number.isFinite(scrollX) ? scrollX : 0, Number.isFinite(scrollY) ? scrollY : 0)
}

function secondarySidebarHashIsOpen(hash: Record<string, unknown> = router.values.hashParams): boolean {
  return searchValue(hash, SECONDARY_SIDEBAR_HASH_KEY) === SECONDARY_SIDEBAR_HASH_VALUE
}

function secondarySidebarOpenHash(hash: Record<string, unknown> = router.values.hashParams): Record<string, unknown> {
  return { ...hash, [SECONDARY_SIDEBAR_HASH_KEY]: SECONDARY_SIDEBAR_HASH_VALUE }
}

function secondarySidebarClosedHash(hash: Record<string, unknown> = router.values.hashParams): Record<string, unknown> {
  const nextHash = { ...hash }
  delete nextHash[SECONDARY_SIDEBAR_HASH_KEY]
  return nextHash
}

function syncSecondarySidebarHash(open: boolean): void {
  if (!isMobileWorkspaceViewport()) {
    return
  }

  const hashOpen = secondarySidebarHashIsOpen()
  if (open && !hashOpen) {
    router.actions.push(router.values.location.pathname, router.values.searchParams, secondarySidebarOpenHash())
  } else if (!open && hashOpen) {
    router.actions.replace(router.values.location.pathname, router.values.searchParams, secondarySidebarClosedHash())
  }
}

function isSceneUtilityPanel(panel: unknown): panel is SceneUtilityPanel {
  return typeof panel === 'string' && (sceneUtilityPanels as readonly string[]).includes(panel)
}

function sceneUtilityPanelFromHashValue(value: string | null): SceneUtilityPanel | null {
  if (value === 'preview') {
    return 'state'
  }
  return isSceneUtilityPanel(value) ? value : null
}

function utilityDrawerHashPanel(hash: Record<string, unknown> = router.values.hashParams): SceneUtilityPanel | null {
  return sceneUtilityPanelFromHashValue(searchValue(hash, UTILITY_DRAWER_HASH_KEY))
}

function utilityDrawerOpenHash(
  panel: SceneUtilityPanel,
  hash: Record<string, unknown> = router.values.hashParams
): Record<string, unknown> {
  return { ...hash, [UTILITY_DRAWER_HASH_KEY]: sceneUtilityPanelHashValues[panel] }
}

function utilityDrawerClosedHash(hash: Record<string, unknown> = router.values.hashParams): Record<string, unknown> {
  const nextHash = { ...hash }
  delete nextHash[UTILITY_DRAWER_HASH_KEY]
  return nextHash
}

function workspaceContentNavigationHash(
  hash: Record<string, unknown> = router.values.hashParams
): Record<string, unknown> {
  return secondarySidebarClosedHash(hash)
}

function isSceneRoutePath(pathname: string = router.values.location.pathname): boolean {
  const scenesPath = urls.scenes()
  return pathname === scenesPath || pathname.startsWith(`${scenesPath}/`)
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
  return frameIsActive(frame)
}

function frameIsActiveInCurrentState(frame: FrameType): boolean {
  return frameIsActiveForHome(frame)
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

function sceneTileElement(frameId: number | string, sceneId: string): HTMLElement | null {
  if (typeof document === 'undefined') {
    return null
  }

  const frameIdString = String(frameId)
  const candidates = Array.from(document.querySelectorAll<HTMLElement>('[data-workspace-scene-tile]')).filter(
    (tile) => tile.dataset.workspaceSceneTileFrame === frameIdString && tile.dataset.workspaceSceneTile === sceneId
  )
  return visibleWorkspaceTile(candidates)
}

function addSceneTileElement(frameId: number | string): HTMLElement | null {
  if (typeof document === 'undefined') {
    return null
  }

  const frameIdString = String(frameId)
  const candidates = Array.from(document.querySelectorAll<HTMLElement>('[data-workspace-add-scene-tile]')).filter(
    (tile) => tile.dataset.workspaceAddSceneTileFrame === frameIdString
  )
  return visibleWorkspaceTile(candidates)
}

function visibleWorkspaceTile(candidates: HTMLElement[]): HTMLElement | null {
  if (candidates.length === 0) {
    return null
  }

  const main = framesMainElement()
  if (!main) {
    return candidates[0]
  }

  const mainRect = main.getBoundingClientRect()
  return (
    candidates.find((tile) => {
      const rect = tile.getBoundingClientRect()
      return rect.bottom >= mainRect.top && rect.top <= mainRect.bottom
    }) ?? candidates[0]
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

export function scrollFramesHomeToTop(behavior: ScrollBehavior = 'auto', stabilize = true): void {
  if (typeof window === 'undefined') {
    return
  }

  const scrollToTop = (attempt = 0): void => {
    const main = framesMainElement()
    if (main) {
      main.scrollTo({ top: 0, behavior: attempt === 0 ? behavior : 'auto' })
    }
    window.scrollTo({ top: 0, behavior: attempt === 0 ? behavior : 'auto' })

    if (stabilize && attempt < 20) {
      window.setTimeout(() => scrollToTop(attempt + 1), 50)
    } else if (nextFramesRouteScrollIntent === 'top') {
      nextFramesRouteScrollIntent = null
    }
  }

  window.requestAnimationFrame(() => scrollToTop())
}

function preserveFramesScrollAfterLayoutChange(cache: Record<string, any>): void {
  if (nextFramesRouteScrollIntent === 'top') {
    return
  }

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

function scrollSceneTileIntoView(frameId: number, sceneId: string): boolean {
  const tile = sceneTileElement(frameId, sceneId)
  return scrollWorkspaceTileIntoView(tile)
}

function scrollAddSceneTileIntoView(frameId: number): boolean {
  const tile = addSceneTileElement(frameId)
  return scrollWorkspaceTileIntoView(tile)
}

function scrollWorkspaceTileIntoView(tile: HTMLElement | null): boolean {
  const main = framesMainElement()
  if (!tile) {
    return false
  }

  if (!main || main.scrollHeight <= main.clientHeight) {
    tile.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
    return true
  }

  const margin = 16
  const bottomMargin = 46
  const mainRect = main.getBoundingClientRect()
  const tileRect = tile.getBoundingClientRect()
  const topOverflow = tileRect.top - mainRect.top - margin
  const bottomOverflow = tileRect.bottom - mainRect.bottom + bottomMargin

  if (topOverflow < 0) {
    main.scrollTo({ top: main.scrollTop + topOverflow, behavior: 'smooth' })
  } else if (bottomOverflow > 0) {
    main.scrollTo({ top: main.scrollTop + bottomOverflow, behavior: 'smooth' })
  }
  return true
}

function ensureAddSceneTileVisibleAfterLayoutChange(frameId: number, cache: Record<string, any>): void {
  ensureWorkspaceTileVisibleAfterLayoutChange(() => scrollAddSceneTileIntoView(frameId), cache)
}

function ensureSceneTileVisibleAfterLayoutChange(frameId: number, sceneId: string, cache: Record<string, any>): void {
  ensureWorkspaceTileVisibleAfterLayoutChange(() => scrollSceneTileIntoView(frameId, sceneId), cache)
}

function ensureWorkspaceTileVisibleAfterLayoutChange(didScroll: () => boolean, cache: Record<string, any>): void {
  if (typeof window === 'undefined') {
    return
  }

  if (cache.sceneTileScrollFrame) {
    window.cancelAnimationFrame(cache.sceneTileScrollFrame)
  }
  if (cache.sceneTileScrollNestedFrame) {
    window.cancelAnimationFrame(cache.sceneTileScrollNestedFrame)
  }
  if (cache.sceneTileScrollRetryTimer) {
    window.clearTimeout(cache.sceneTileScrollRetryTimer)
    cache.sceneTileScrollRetryTimer = null
  }

  const scheduleScroll = (attempt = 0) => {
    cache.sceneTileScrollFrame = window.requestAnimationFrame(() => {
      cache.sceneTileScrollNestedFrame = window.requestAnimationFrame(() => {
        const scrolled = didScroll()
        cache.sceneTileScrollFrame = null
        cache.sceneTileScrollNestedFrame = null
        if (!scrolled && attempt < 20) {
          cache.sceneTileScrollRetryTimer = window.setTimeout(() => scheduleScroll(attempt + 1), 50)
        }
      })
    })
  }

  scheduleScroll()
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
    closeSecondarySidebar: true,
    toggleSecondarySidebar: true,
    selectFrame: (frameId: number | null) => ({ frameId }),
    focusFrame: (frameId: number) => ({ frameId }),
    setRouteSelection: (frameId: number | null, sceneId: string | null = null) => ({ frameId, sceneId }),
    rememberAppsHref: (href: string) => ({ href }),
    navigateToFrame: (frameId: number) => ({ frameId }),
    openFrameTool: (frameId: number, panel: WorkspaceUtilityPanel) => ({ frameId, panel }),
    navigateToSceneFrame: (frameId: number) => ({ frameId }),
    navigateToScene: (frameId: number, sceneId: string) => ({ frameId, sceneId }),
    openScenePreview: (frameId: number, sceneId: string) => ({ frameId, sceneId }),
    openSceneControl: (frameId: number, sceneId: string) => ({ frameId, sceneId }),
    closeSceneControl: true,
    openTemplateDrawer: (frameId: number) => ({ frameId }),
    closeTemplateDrawer: true,
    openScheduleDrawer: (frameId: number) => ({ frameId }),
    closeScheduleDrawer: true,
    openChatDrawer: (frameId: number, sceneId: string | null = null, nodeId: string | null = null) => ({
      frameId,
      nodeId,
      sceneId,
    }),
    closeChatDrawer: true,
    openFrameChangeDrawer: (
      frameId: number,
      kind: FrameChangeDrawerKind,
      deployDrawerView?: DeployDrawerView,
      preferFrameRoute?: boolean
    ) => ({
      deployDrawerView,
      frameId,
      kind,
      preferFrameRoute,
    }),
    closeFrameChangeDrawer: true,
    retargetOpenFrameDrawers: (
      frameId: number,
      previousFrameChangeDrawerSelection: FrameChangeDrawerSelection | null
    ) => ({ frameId, previousFrameChangeDrawerSelection }),
    openUtilityPanel: (panel: WorkspaceUtilityPanel) => ({ panel }),
    closeUtilityPanel: true,
    selectNode: (nodeId: string | null) => ({ nodeId }),
    openRenameFrameDialog: (frameId: number, name: string) => ({ frameId, name }),
    setRenameFrameName: (name: string) => ({ name }),
    closeRenameFrameDialog: true,
    snapshotFrameOrder: true,
    setFrameOrderSnapshot: (frameIds: number[], activeFrameIds: number[]) => ({ frameIds, activeFrameIds }),
    rememberFrameToolScroll: (frameId: number, panel: WorkspaceUtilityPanel, scrollTop: number) => ({
      frameId,
      panel,
      scrollTop,
    }),
    rememberTerminalSessionFrame: (frameId: number) => ({ frameId }),
    setFrameAssetFolderExpanded: (frameId: number, path: string, expanded: boolean) => ({
      frameId,
      path,
      expanded,
    }),
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
        closeSecondarySidebar: () => false,
        toggleSecondarySidebar: (open) => !open,
      },
    ],
    renameFrameDialog: [
      null as FrameRenameDialog | null,
      {
        openRenameFrameDialog: (_, { frameId, name }) => ({ frameId, name }),
        setRenameFrameName: (state, { name }) => (state ? { ...state, name } : state),
        closeRenameFrameDialog: () => null,
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
        openScenePreview: (state, { frameId, sceneId }) => ({ ...state, [frameId]: sceneId }),
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
        openScenePreview: () => null,
        openChatDrawer: () => null,
        openUtilityPanel: () => null,
        openTemplateDrawer: () => null,
        openScheduleDrawer: () => null,
        openFrameChangeDrawer: () => null,
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
        openScenePreview: () => null,
        openSceneControl: () => null,
        openScheduleDrawer: () => null,
        openChatDrawer: () => null,
        openFrameChangeDrawer: () => null,
        retargetOpenFrameDrawers: (state, { frameId }) => (state === null ? state : frameId),
        openUtilityPanel: (state, { panel }) => (panel === 'scenes' ? state : null),
      },
    ],
    scheduleDrawerFrameId: [
      null as number | null,
      {
        openScheduleDrawer: () => null,
        closeScheduleDrawer: () => null,
        setSearch: () => null,
        navigateToFrame: () => null,
        openFrameTool: () => null,
        navigateToSceneFrame: () => null,
        navigateToScene: () => null,
        openScenePreview: () => null,
        openTemplateDrawer: () => null,
        openSceneControl: () => null,
        openChatDrawer: () => null,
        openFrameChangeDrawer: () => null,
      },
    ],
    chatDrawerSelection: [
      null as ChatDrawerSelection | null,
      {
        openChatDrawer: (_, { frameId, sceneId, nodeId }) => ({ frameId, nodeId, sceneId }),
        closeChatDrawer: () => null,
        setSearch: () => null,
        navigateToFrame: () => null,
        openFrameTool: () => null,
        navigateToSceneFrame: () => null,
        navigateToScene: () => null,
        openScenePreview: () => null,
        openSceneControl: () => null,
        openTemplateDrawer: () => null,
        openScheduleDrawer: () => null,
        openFrameChangeDrawer: () => null,
        openUtilityPanel: () => null,
      },
    ],
    frameChangeDrawerSelection: [
      null as FrameChangeDrawerSelection | null,
      {
        openFrameChangeDrawer: (state, { frameId, kind, deployDrawerView }) => ({
          deployDrawerView:
            deployDrawerView ??
            (state?.frameId === frameId && state.kind === kind ? state.deployDrawerView : undefined),
          frameId,
          kind,
        }),
        closeFrameChangeDrawer: () => null,
        setSearch: () => null,
        navigateToFrame: () => null,
        openFrameTool: () => null,
        navigateToSceneFrame: () => null,
        navigateToScene: () => null,
        openScenePreview: () => null,
        openSceneControl: () => null,
        openTemplateDrawer: () => null,
        openScheduleDrawer: () => null,
        openChatDrawer: () => null,
        openUtilityPanel: () => null,
        retargetOpenFrameDrawers: (state, { frameId }) => (state ? { ...state, frameId } : state),
      },
    ],
    utilityPanel: [
      null as WorkspaceUtilityPanel | null,
      {
        openUtilityPanel: (_, { panel }) => panel,
        openFrameTool: (_, { panel }) => panel,
        openScenePreview: () => 'state',
        closeUtilityPanel: () => null,
      },
    ],
    selectedNodeId: [
      null as string | null,
      {
        selectNode: (_, { nodeId }) => nodeId,
        navigateToScene: () => null,
        openScenePreview: () => null,
        setRouteSelection: () => null,
      },
    ],
    lastAppsHref: [
      null as string | null,
      { persist: true, storageKey: 'workspaceLogic.lastAppsHref' },
      {
        rememberAppsHref: (_, { href }) => href,
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
    frameToolScrollPositions: [
      {} as Record<string, number>,
      {
        rememberFrameToolScroll: (state, { frameId, panel, scrollTop }) => {
          const key = frameToolScrollKey(frameId, panel)
          const nextScrollTop = Math.max(0, Math.round(scrollTop))
          if (state[key] === nextScrollTop) {
            return state
          }
          return {
            ...state,
            [key]: nextScrollTop,
          }
        },
      },
    ],
    terminalSessionFrameIds: [
      [] as number[],
      {
        rememberTerminalSessionFrame: (state, { frameId }) => (state.includes(frameId) ? state : [...state, frameId]),
      },
    ],
    frameAssetFolderExpansion: [
      {} as Record<string, boolean>,
      { persist: true, storageKey: 'workspaceLogic.frameAssetFolderExpansion' },
      {
        setFrameAssetFolderExpanded: (state, { frameId, path, expanded }) => {
          const key = frameAssetFolderExpansionKey(frameId, path)
          if (expanded) {
            if (path === '') {
              if (!Object.prototype.hasOwnProperty.call(state, key)) {
                return state
              }
              const { [key]: _, ...nextState } = state
              return nextState
            }
            return state[key] ? state : { ...state, [key]: true }
          }
          if (path === '') {
            return state[key] === false ? state : { ...state, [key]: false }
          }
          if (!state[key]) {
            return state
          }
          const { [key]: _, ...nextState } = state
          return nextState
        },
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
      (s) => [s.orderedActiveFramesList],
      (orderedActiveFramesList): FrameType[] => orderedActiveFramesList.filter(frameIsActiveInCurrentState),
    ],
    homeInactiveFramesList: [
      (s) => [s.orderedActiveFramesList],
      (orderedActiveFramesList): FrameType[] =>
        orderedActiveFramesList.filter((frame) => !frameIsActiveInCurrentState(frame)),
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
      (s) => [s.overviewFrameSections],
      (overviewFrameSections): OverviewFrameSection[] =>
        overviewFrameSections.filter((section) => !section.archived && frameIsActiveInCurrentState(section.frame)),
    ],
    overviewInactiveFrameSections: [
      (s) => [s.overviewFrameSections],
      (overviewFrameSections): OverviewFrameSection[] =>
        overviewFrameSections.filter((section) => !section.archived && !frameIsActiveInCurrentState(section.frame)),
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
    const hideNewFrameFormAndPreserveScroll = () => {
      newFrameForm.actions.hideForm()
      if (isMobileWorkspaceViewport()) {
        actions.closeSecondarySidebar()
      }
      preserveFramesScroll()
    }

    return {
      openSecondarySidebar: () => {
        syncSecondarySidebarHash(true)
        applyWorkspaceScrollGuard(true)
      },
      closeSecondarySidebar: () => {
        syncSecondarySidebarHash(false)
        applyWorkspaceScrollGuard(false)
      },
      toggleSecondarySidebar: () => {
        syncSecondarySidebarHash(values.secondarySidebarOpen)
        applyWorkspaceScrollGuard(values.secondarySidebarOpen)
      },
      openSceneControl: ({ frameId, sceneId }) => {
        newFrameForm.actions.hideForm()
        if (isMobileWorkspaceViewport()) {
          actions.closeSecondarySidebar()
        }
        preserveFramesScroll()
        ensureSceneTileVisibleAfterLayoutChange(frameId, sceneId, cache)
      },
      closeSceneControl: preserveFramesScroll,
      openTemplateDrawer: ({ frameId }) => {
        hideNewFrameFormAndPreserveScroll()
        ensureAddSceneTileVisibleAfterLayoutChange(frameId, cache)
      },
      closeTemplateDrawer: preserveFramesScroll,
      openScheduleDrawer: hideNewFrameFormAndPreserveScroll,
      closeScheduleDrawer: preserveFramesScroll,
      openChatDrawer: hideNewFrameFormAndPreserveScroll,
      closeChatDrawer: preserveFramesScroll,
      openFrameChangeDrawer: ({ frameId, deployDrawerView }) => {
        if (cache.skipNextFrameChangeDrawerScrollPreserve) {
          cache.skipNextFrameChangeDrawerScrollPreserve = false
          newFrameForm.actions.hideForm()
          if (isMobileWorkspaceViewport()) {
            actions.closeSecondarySidebar()
          }
        } else {
          hideNewFrameFormAndPreserveScroll()
        }
        const frameActions = frameLogic({ frameId }).actions
        frameActions.setDeployDrawerView(
          deployDrawerView ?? values.frameChangeDrawerSelection?.deployDrawerView ?? 'main'
        )
        frameActions.showDeployPlanModal()
      },
      closeFrameChangeDrawer: preserveFramesScroll,
      retargetOpenFrameDrawers: ({ frameId, previousFrameChangeDrawerSelection }) => {
        if (
          !previousFrameChangeDrawerSelection ||
          previousFrameChangeDrawerSelection.frameId === frameId ||
          previousFrameChangeDrawerSelection.kind !== values.frameChangeDrawerSelection?.kind
        ) {
          return
        }

        const previousFrameActions = frameLogic({ frameId: previousFrameChangeDrawerSelection.frameId }).actions
        previousFrameActions.hideDeployPlanModal()

        const nextFrameActions = frameLogic({ frameId }).actions
        nextFrameActions.showDeployPlanModal()
      },
      [newFrameForm.actionTypes.showForm]: preserveFramesScroll,
      [newFrameForm.actionTypes.hideForm]: preserveFramesScroll,
      [newFrameForm.actionTypes.frameCreated]: ({ frameId, installMethod }) => {
        const deployDrawerView = installMethod === 'sd_card' ? 'sdCard' : installMethod === 'script' ? 'script' : 'main'
        actions.setSearch('')
        actions.selectFrame(frameId)
        cache.skipNextFrameChangeDrawerScrollPreserve = true
        actions.openFrameChangeDrawer(frameId, 'deploy', deployDrawerView, true)
      },
      setTheme: ({ theme }) => {
        window.localStorage.setItem('frameos.workspaceTheme', theme)
        applyFrameosTheme(theme)
      },
      toggleTheme: () => {
        window.localStorage.setItem('frameos.workspaceTheme', values.theme)
        applyFrameosTheme(values.theme)
      },
      focusFrame: ({ frameId }) => {
        const scrollToFrame = (attempt = 0) => {
          const frameElement = document.getElementById(`workspace-frame-${frameId}`)
          if (frameElement) {
            if (isMobileWorkspaceViewport()) {
              const headerOffset = window.matchMedia?.('(max-width: 639px)').matches ? 96 : 104
              const top = frameElement.getBoundingClientRect().top + window.scrollY - headerOffset
              window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
              return
            }
            frameElement.scrollIntoView({ behavior: 'smooth', block: 'start' })
            return
          }
          if (attempt < 20) {
            window.setTimeout(() => scrollToFrame(attempt + 1), 50)
          }
        }
        window.requestAnimationFrame(() => scrollToFrame())
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
        router.actions.push(urls.scenes(frameId), undefined, workspaceContentNavigationHash())
      },
      navigateToScene: ({ frameId, sceneId }) => {
        actions.setRouteSelection(frameId, sceneId)
        router.actions.push(urls.scenes(frameId, sceneId), undefined, workspaceContentNavigationHash())
      },
      openScenePreview: ({ frameId, sceneId }) => {
        actions.setRouteSelection(frameId, sceneId)
        router.actions.push(
          urls.scenes(frameId, sceneId),
          {},
          utilityDrawerOpenHash('state', workspaceContentNavigationHash())
        )
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
  urlToAction(({ actions, values }) => {
    const syncSecondarySidebarFromHashForMobile = (hash: Record<string, unknown> = router.values.hashParams) => {
      if (!isMobileWorkspaceViewport()) {
        return
      }
      if (secondarySidebarHashIsOpen(hash)) {
        actions.openSecondarySidebar()
      } else {
        actions.closeSecondarySidebar()
      }
    }
    const applyUtilityDrawerFromHash = (
      hash: Record<string, unknown>,
      payload: { initial?: boolean },
      previousLocation: { hashParams?: Record<string, unknown> }
    ) => {
      const panel = utilityDrawerHashPanel(hash)
      if (panel) {
        actions.openUtilityPanel(panel)
        return
      }
      if (!payload.initial && utilityDrawerHashPanel(previousLocation.hashParams ?? {})) {
        actions.closeUtilityPanel()
      }
    }
    const closeDrawersFromUrl = () => {
      if (values.sceneControlSelection) {
        actions.closeSceneControl()
      }
      if (values.templateDrawerFrameId) {
        actions.closeTemplateDrawer()
      }
      if (values.scheduleDrawerFrameId) {
        actions.closeScheduleDrawer()
      }
      if (values.chatDrawerSelection) {
        actions.closeChatDrawer()
      }
      if (values.frameChangeDrawerSelection) {
        const frameActions = frameLogic({ frameId: values.frameChangeDrawerSelection.frameId }).actions
        frameActions.hideDeployPlanModal()
        actions.closeFrameChangeDrawer()
      }
    }
    const applyDrawerFromSearch = (frameId: number | null, search: Record<string, unknown>) => {
      const drawer = searchValue(search, 'drawer')
      const sceneId = searchValue(search, 'sceneId')
      const nodeId = searchValue(search, 'nodeId')

      if (!frameId) {
        closeDrawersFromUrl()
        return
      }

      if (drawer === 'scene' && sceneId) {
        actions.openSceneControl(frameId, sceneId)
      } else if (drawer === 'templates') {
        actions.openTemplateDrawer(frameId)
      } else if (drawer === 'schedule') {
        actions.openFrameTool(frameId, 'schedule')
      } else if (drawer === 'chat') {
        actions.openChatDrawer(frameId, sceneId, nodeId)
      } else if (drawer === 'unsavedChanges') {
        actions.openFrameChangeDrawer(frameId, 'deploy')
      } else if (drawer === 'deployPlan') {
        actions.openFrameChangeDrawer(frameId, 'deploy')
      } else {
        closeDrawersFromUrl()
      }
    }

    const applyFramesRoute = (
      _: Record<string, unknown>,
      search: Record<string, unknown>,
      hash: Record<string, unknown>,
      payload: { initial?: boolean },
      previousLocation: { pathname: string }
    ) => {
      const scrollIntent = nextFramesRouteScrollIntent
      syncSecondarySidebarFromHashForMobile(hash)
      const drawerFrameId = drawerFrameIdFromSearch(search)
      applyDrawerFromSearch(drawerFrameId, search)
      const previousFrameId = frameIdFromWorkspacePath(previousLocation.pathname)
      nextFramesRouteScrollIntent = null
      if (scrollIntent === 'top') {
        scrollFramesHomeToTop()
        return
      }
      if (!payload.initial && !drawerFrameId && previousFrameId) {
        actions.focusFrame(previousFrameId)
      }
    }
    const applySceneOrAppRoute = (
      { frameId, sceneId, nodeId }: Record<string, unknown>,
      search: Record<string, unknown>,
      hash: Record<string, unknown>,
      payload: { pathname: string; initial?: boolean },
      previousLocation: { hashParams?: Record<string, unknown> }
    ) => {
      syncSecondarySidebarFromHashForMobile(hash)
      const validFrameId = Number(frameId)
      const validSceneId = typeof sceneId === 'string' ? sceneId : null
      const routeNodeId = searchValue(search, 'nodeId') ?? (typeof nodeId === 'string' ? nodeId : null)

      if (Number.isFinite(validFrameId)) {
        actions.setRouteSelection(validFrameId, validSceneId)
        if (routeNodeId) {
          actions.selectNode(routeNodeId)
        }
        const drawer = searchValue(search, 'drawer')
        applyDrawerFromSearch(validFrameId, {
          ...search,
          nodeId: routeNodeId ?? undefined,
          sceneId: searchValue(search, 'sceneId') ?? validSceneId ?? undefined,
        })
        if (!drawer && isSceneRoutePath(payload.pathname)) {
          applyUtilityDrawerFromHash(hash, payload, previousLocation)
        }
      } else {
        closeDrawersFromUrl()
      }
    }
    const framesPath = framesRoutePath()

    return {
      [framesPath]: applyFramesRoute,
      [`${framesPath.replace(/\/$/, '')}/`]: applyFramesRoute,
      [urls.frame(':id')]: ({ id }, search, hash) => {
        syncSecondarySidebarFromHashForMobile(hash)
        const frameId = parseInt(String(id), 10)
        const validFrameId = Number.isFinite(frameId) ? frameId : null
        if (validFrameId) {
          actions.selectFrame(validFrameId)
        }
        actions.openUtilityPanel(frameToolFromSearch(search))
        applyDrawerFromSearch(validFrameId, search)
      },
      [urls.scenes(':frameId')]: applySceneOrAppRoute,
      [urls.scenes(':frameId', ':sceneId')]: applySceneOrAppRoute,
      [urls.apps(':frameId')]: applySceneOrAppRoute,
      [urls.apps(':frameId', ':sceneId')]: applySceneOrAppRoute,
      [urls.apps(':frameId', ':sceneId', ':nodeId')]: applySceneOrAppRoute,
    }
  }),
  actionToUrl(() => ({
    openSceneControl: (payload: Record<string, any>) =>
      drawerUrlForFrame(Number(payload.frameId), 'scene', { sceneId: String(payload.sceneId) }),
    closeSceneControl: clearDrawerUrl,
    openTemplateDrawer: (payload: Record<string, any>) => drawerUrlForFrame(Number(payload.frameId), 'templates'),
    closeTemplateDrawer: clearDrawerUrl,
    openScheduleDrawer: (payload: Record<string, any>) => [
      urls.frame(Number(payload.frameId)),
      { ...clearDrawerSearchParams(router.values.searchParams), tool: 'schedule' },
      utilityDrawerClosedHash(),
    ],
    closeScheduleDrawer: clearDrawerUrl,
    openChatDrawer: (payload: Record<string, any>) =>
      drawerUrlForFrame(Number(payload.frameId), 'chat', {
        ...(payload.sceneId ? { sceneId: String(payload.sceneId) } : {}),
        ...(payload.nodeId ? { nodeId: String(payload.nodeId) } : {}),
      }),
    closeChatDrawer: clearDrawerUrl,
    openFrameChangeDrawer: (payload: Record<string, any>) =>
      payload.preferFrameRoute
        ? [
            urls.frame(Number(payload.frameId)),
            {
              ...clearDrawerSearchParams(router.values.searchParams),
              drawer: 'deployPlan',
              tool: 'overview',
            },
            utilityDrawerClosedHash(),
          ]
        : drawerUrlForFrame(Number(payload.frameId), 'deployPlan'),
    closeFrameChangeDrawer: clearDrawerUrl,
    openUtilityPanel: (payload: Record<string, any>) => {
      const panel = payload.panel
      if (!isSceneRoutePath() || !isSceneUtilityPanel(panel)) {
        return undefined
      }
      return [
        router.values.location.pathname,
        clearDrawerSearchParams(router.values.searchParams),
        utilityDrawerOpenHash(panel),
      ]
    },
    closeUtilityPanel: () => {
      if (!isSceneRoutePath() || !utilityDrawerHashPanel()) {
        return undefined
      }
      return [router.values.location.pathname, router.values.searchParams, utilityDrawerClosedHash(), { replace: true }]
    },
  })),
  afterMount(({ actions, cache, values }) => {
    applyFrameosTheme(values.theme)
    if (typeof window !== 'undefined') {
      const mobileWorkspaceQuery = window.matchMedia?.(MOBILE_WORKSPACE_MEDIA_QUERY)
      const syncScrollGuardForViewport = () => applyWorkspaceScrollGuard(workspaceLogic.values.secondarySidebarOpen)
      if (mobileWorkspaceQuery) {
        cache.mobileWorkspaceQuery = mobileWorkspaceQuery
        cache.syncScrollGuardForViewport = syncScrollGuardForViewport
        if (mobileWorkspaceQuery.addEventListener) {
          mobileWorkspaceQuery.addEventListener('change', syncScrollGuardForViewport)
        } else {
          mobileWorkspaceQuery.addListener?.(syncScrollGuardForViewport)
        }
      }
    }
    if (isMobileWorkspaceViewport()) {
      if (secondarySidebarHashIsOpen()) {
        actions.openSecondarySidebar()
      } else {
        actions.closeSecondarySidebar()
      }
    } else {
      applyWorkspaceScrollGuard(false)
    }
  }),
  events(({ cache }) => ({
    beforeUnmount: () => {
      if (cache.mobileWorkspaceQuery?.removeEventListener) {
        cache.mobileWorkspaceQuery.removeEventListener('change', cache.syncScrollGuardForViewport)
      } else {
        cache.mobileWorkspaceQuery?.removeListener?.(cache.syncScrollGuardForViewport)
      }
      if (typeof window !== 'undefined') {
        if (cache.sceneTileScrollFrame) {
          window.cancelAnimationFrame(cache.sceneTileScrollFrame)
        }
        if (cache.sceneTileScrollNestedFrame) {
          window.cancelAnimationFrame(cache.sceneTileScrollNestedFrame)
        }
        if (cache.sceneTileScrollRetryTimer) {
          window.clearTimeout(cache.sceneTileScrollRetryTimer)
        }
      }
      applyWorkspaceScrollGuard(false)
    },
  })),
])
