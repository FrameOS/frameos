import { BindLogic, useActions, useMountedLogic, useValues } from 'kea'
import { router } from 'kea-router'
import clsx from 'clsx'
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import {
  ArrowLeftIcon,
  ArrowTopRightOnSquareIcon,
  CodeBracketIcon,
  CubeTransparentIcon,
} from '@heroicons/react/24/outline'
import Editor from '@monaco-editor/react'
import type { editor as importedEditor } from 'monaco-editor'
import type { Monaco } from '@monaco-editor/react'
import { appsModel, categoryLabels } from '../../models/appsModel'
import { framesModel } from '../../models/framesModel'
import { frameHost } from '../../decorators/frame'
import { urls } from '../../urls'
import {
  type AppConfig,
  type AppNodeData,
  type DiagramNode,
  type FrameScene,
  type FrameType,
  FrameId,
} from '../../types'
import { frameIdsEqual, parseRouteFrameId } from '../../utils/frameId'
import { FrameosShell } from './FrameosShell'
import { activeAppSelectionLogic } from './activeAppSelectionLogic'
import { appsWorkspaceLogic, SYSTEM_APPS_ROUTE_TOKEN } from './appsWorkspaceLogic'
import { workspaceLogic } from './workspaceLogic'
import { frameLogic } from '../frame/frameLogic'
import { editAppEditorKey, frameEditorsLogic } from '../frame/frameEditorsLogic'
import {
  appSourceEditorLanguage,
  configureAppSourceEditor,
  EditApp,
  EditAppFileList,
  systemAppGithubUrl,
} from '../frame/panels/EditApp/EditApp'
import { editAppLogic } from '../frame/panels/EditApp/editAppLogic'
import { groupFramesByStatus } from './frameStatusGroups'
import { FrameActionsMenu } from './FrameActionsMenu'
import {
  hasJavaScriptAppSource,
  isJavaScriptCatalogApp,
  isRepoAppKeyword,
  normalizeSceneApps,
} from '../../utils/sceneApps'
import { systemAppSourceLogic } from './systemAppSourceLogic'
import { isInFrameAdminMode } from '../../utils/frameAdmin'
import { isCloudMode } from '../../utils/cloudMode'
import { inmemoryModelPath } from '../../utils/monacoPaths'

interface AppsWorkspaceProps {
  frameId?: string
  sceneId?: string
  nodeId?: string
  /** The cloud's /apps/system/:keyword route; self-hosted the keyword rides
   * in sceneId's place (/apps/system/:sceneId, "system" as the frame). */
  keyword?: string
}

// On the cloud the system apps have routes without a frame param — /apps
// (the home) and /apps/system[/<keyword>], beside /apps/frames/… — so the
// path says which side of the toggle the route is.
function isCloudSystemAppsPath(pathname: string): boolean {
  if (!isCloudMode()) {
    return false
  }
  const systemPath = urls.systemApps()
  return pathname === urls.appsHome() || pathname === systemPath || pathname.startsWith(`${systemPath}/`)
}

type AppsSourceMode = 'system' | 'frames'

interface AppsWorkspaceFrameProps {
  frameId: FrameId
  sourceMode: AppsSourceMode
  routeSceneId?: string | null
  routeNodeId?: string | null
  routeSystemAppKeyword?: string | null
  /** ?file=: the file open in the editor (an app without one shows its overview). */
  routeFile?: string | null
}

interface AppNodeOption {
  sceneId: string
  sceneName: string
  nodeId: string
  label: string
  keyword: string
  nodeData: AppNodeData
  language: AppNodeLanguage
}

type AppNodeLanguage = 'nim' | 'javascript'

interface AppNodeSceneGroup {
  key: string
  label: string
  options: AppNodeOption[]
}

interface SystemAppOption {
  keyword: string
  label: string
  category: string
  categoryLabel: string
  /** A repo JavaScript app (repo/apps/<folder>/<name>) rather than a Nim one. */
  javascript: boolean
}

function appNodeLanguage(
  keyword: string,
  sources?: Record<string, string> | null,
  origin?: string | null
): AppNodeLanguage {
  return hasJavaScriptAppSource(sources) || isJavaScriptCatalogApp(keyword) || isJavaScriptCatalogApp(origin)
    ? 'javascript'
    : 'nim'
}

function decodeRouteKeyword(value?: string | null): string | null {
  if (!value) {
    return null
  }
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function appNodeOptions(scene: FrameScene | null | undefined): AppNodeOption[] {
  const sceneApps = normalizeSceneApps(scene?.apps)
  return (scene?.nodes ?? [])
    .filter((node): node is DiagramNode => node.type === 'app')
    .map((node) => {
      const nodeData = node.data as AppNodeData
      const keyword = nodeData.keyword ?? ''
      const sceneApp = sceneApps[keyword]
      const sources = nodeData.sources || sceneApp?.sources || null
      return {
        sceneId: scene?.id ?? '',
        sceneName: scene?.name || 'Untitled scene',
        nodeId: node.id,
        label: nodeData.name || keyword || node.id,
        keyword,
        nodeData,
        language: appNodeLanguage(keyword, sources, sceneApp?.origin),
      }
    })
}

function appNodeOptionsForScenes(scenes: FrameScene[]): AppNodeOption[] {
  return scenes.flatMap((scene) => appNodeOptions(scene))
}

function frameAdminAppOptions(appOptions: AppNodeOption[]): AppNodeOption[] {
  return appOptions.filter((app) => app.language === 'javascript')
}

function appOptionKey(app: AppNodeOption): string {
  return `${app.sceneId}::${app.nodeId}`
}

function appNodeSceneGroups(appOptions: AppNodeOption[]): AppNodeSceneGroup[] {
  const groups: AppNodeSceneGroup[] = []
  for (const option of appOptions) {
    let group = groups.find((candidate) => candidate.key === option.sceneId)
    if (!group) {
      group = { key: option.sceneId, label: option.sceneName, options: [] }
      groups.push(group)
    }
    group.options.push(option)
  }
  return groups
}

// The folder a repo JS app sits in names what it returns (repo/apps/image,
// text, json, logic); that is its group here, after the Nim categories.
const repoAppFolderLabels: Record<string, string> = {
  image: 'JavaScript: image',
  text: 'JavaScript: text',
  json: 'JavaScript: JSON',
  logic: 'JavaScript: logic',
}

function repoAppGroup(keyword: string): { key: string; label: string } {
  const folder = keyword.split('/')[2] ?? 'other'
  return { key: `javascript:${folder}`, label: repoAppFolderLabels[folder] ?? `JavaScript: ${folder}` }
}

// Every catalog app: the repo JavaScript apps by folder, then the built-in
// Nim apps by category. Both are read only here; the sources of the
// repo apps are embedded in the bundle, the Nim ones come from the API.
function systemAppOptions(apps: Record<string, AppConfig>): SystemAppOption[] {
  return Object.entries(apps)
    .map(([keyword, app]) => {
      const javascript = isRepoAppKeyword(keyword)
      const group = javascript ? repoAppGroup(keyword) : null
      return {
        keyword,
        label: app.name || keyword.slice(keyword.lastIndexOf('/') + 1),
        category: group?.key ?? (app.category || 'other').toLowerCase(),
        categoryLabel:
          group?.label ?? categoryLabels[(app.category || 'other').toLowerCase()] ?? app.category ?? 'Other',
        javascript,
      }
    })
    .toSorted((a, b) => {
      // The JavaScript apps first: they are what a scene author writes today.
      if (a.javascript !== b.javascript) {
        return a.javascript ? -1 : 1
      }
      const categoryComparison = a.category.localeCompare(b.category)
      return categoryComparison || a.label.localeCompare(b.label)
    })
}

function systemAppOptionGroups(
  options: SystemAppOption[]
): { key: string; label: string; options: SystemAppOption[] }[] {
  const groups: { key: string; label: string; options: SystemAppOption[] }[] = []
  for (const option of options) {
    let group = groups.find((candidate) => candidate.key === option.category)
    if (!group) {
      group = { key: option.category, label: option.categoryLabel, options: [] }
      groups.push(group)
    }
    group.options.push(option)
  }
  return groups
}

// The app the side panel was left through. The lists are long, so when
// the back arrow brings the list back it scrolls that app's row into
// view, where the eye was. Module state: it only has to outlive one
// navigation and never needs to be observed.
let lastOpenedAppKey: string | null = null

function pushFrameAppsUrl(frame: FrameType, app: AppNodeOption | null, file?: string | null): void {
  if (app) {
    lastOpenedAppKey = appOptionKey(app)
  }
  router.actions.push(
    urls.apps(frame.id, app?.sceneId, app?.nodeId) + (app && file ? '?file=' + encodeURIComponent(file) : '')
  )
}

// A system app has two views: its overview (the list stays in the side
// panel; files and a readme-style summary on the right) and, once a file is
// opened (?file=), the editor with the file list in the side panel.
function pushSystemAppsUrl(keyword?: string | null, file?: string | null): void {
  if (keyword) {
    lastOpenedAppKey = keyword
  }
  router.actions.push(urls.systemApps(keyword) + (keyword && file ? '?file=' + encodeURIComponent(file) : ''))
}

// Scrolls the row of the app the list was left through into view, once,
// when a list mounts; the row's own container scrolls (the side panel).
function useScrollToLastOpenedApp(listRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const key = lastOpenedAppKey
    if (!key || !listRef.current) {
      return
    }
    const row = [...listRef.current.querySelectorAll<HTMLElement>('[data-app-key]')].find(
      (element) => element.dataset.appKey === key
    )
    row?.scrollIntoView({ block: 'center' })
  }, [listRef])
}

function SelectionSelect({
  label,
  value,
  disabled,
  onChange,
  leading,
  action,
  children,
}: {
  label: string
  value: string | number
  disabled?: boolean
  onChange: (value: string) => void
  /** Rendered before the select (the app list's back button). */
  leading?: ReactNode
  action?: ReactNode
  children: ReactNode
}): JSX.Element {
  return (
    <div>
      <label className="frameos-muted mb-2 block text-xs font-semibold uppercase tracking-wide">{label}</label>
      <div className="flex items-center gap-2">
        {leading}
        <select
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className="frameos-form-control min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-800 outline-none transition disabled:cursor-not-allowed disabled:opacity-50 focus:ring-2 focus:ring-blue-400"
        >
          {children}
        </select>
        {action}
      </div>
    </div>
  )
}

function SourceModeToggle({
  mode,
  onChange,
}: {
  mode: AppsSourceMode
  onChange: (mode: AppsSourceMode) => void
}): JSX.Element {
  return (
    <div className="apps-source-mode-toggle grid grid-cols-2 rounded-xl border border-slate-200 bg-white/70 p-1 shadow-sm">
      {(['system', 'frames'] as AppsSourceMode[]).map((candidate) => {
        const active = mode === candidate
        return (
          <button
            key={candidate}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(candidate)}
            className={clsx(
              'apps-source-mode-toggle-button h-9 rounded-lg px-3 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
              active
                ? 'frameos-primary-active text-white shadow-sm'
                : 'text-slate-500 hover:bg-white hover:text-slate-800'
            )}
          >
            {candidate === 'system' ? 'System apps' : 'Frames'}
          </button>
        )
      })}
    </div>
  )
}

function EmptyFileList({ label = 'No app selected' }: { label?: string }): JSX.Element {
  return (
    <div className="frameos-inset rounded-2xl border border-slate-200 bg-white/55 p-3">
      <div className="frameos-muted text-xs font-semibold uppercase tracking-wide text-slate-400">Files</div>
      <div className="mt-3 flex items-center gap-2 text-sm font-semibold text-slate-500">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white text-slate-400 shadow-sm">
          <CubeTransparentIcon className="h-4 w-4" />
        </span>
        <span className="truncate">{label}</span>
      </div>
    </div>
  )
}

// The side panel starts as a list of apps; picking one opens its files
// under an "App" select, with this button to the left of the select to get
// the list back. "Back" is the route without an app, so it survives reloads
// and the rail's apps button remembers whichever view was open.
function BackToAppListButton({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      title="All apps"
      aria-label="All apps"
      onClick={onClick}
      className="frameos-form-control flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white !px-0 !py-0 text-slate-700 shadow-none transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
    >
      <ArrowLeftIcon className="h-5 w-5" />
    </button>
  )
}

function AppListGroup({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div>
      <div className="frameos-muted mb-1 px-3 text-xs font-semibold uppercase tracking-wide">{label}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

function AppListRow({
  appKey,
  label,
  detail,
  onClick,
}: {
  appKey: string
  label: string
  detail?: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      data-app-key={appKey}
      onClick={onClick}
      className={clsx(
        'frameos-settings-nav-link flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm font-medium text-slate-700 transition hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
        appKey === lastOpenedAppKey && 'frameos-settings-nav-link-active'
      )}
    >
      <CubeTransparentIcon className="h-4 w-4 shrink-0 opacity-70" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {detail ? <span className="frameos-muted shrink-0 text-xs">{detail}</span> : null}
    </button>
  )
}

function SystemAppList({ systemApps }: { systemApps: SystemAppOption[] }): JSX.Element {
  // The app whose overview is open reads as the current one.
  const listRef = useRef<HTMLElement>(null)
  useScrollToLastOpenedApp(listRef)
  if (systemApps.length === 0) {
    return <EmptyFileList label="No system apps" />
  }
  return (
    <nav ref={listRef} aria-label="System apps" className="space-y-4">
      {systemAppOptionGroups(systemApps).map((group) => (
        <AppListGroup key={group.key} label={group.label}>
          {group.options.map((option) => (
            <AppListRow
              key={option.keyword}
              appKey={option.keyword}
              label={option.label}
              detail={option.javascript ? 'JS' : undefined}
              onClick={() => pushSystemAppsUrl(option.keyword)}
            />
          ))}
        </AppListGroup>
      ))}
    </nav>
  )
}

function FrameAppList({ frame, appOptions }: { frame: FrameType; appOptions: AppNodeOption[] }): JSX.Element {
  const listRef = useRef<HTMLElement>(null)
  useScrollToLastOpenedApp(listRef)
  if (appOptions.length === 0) {
    return <EmptyFileList label="No apps on this frame" />
  }
  return (
    <nav ref={listRef} aria-label="Apps" className="space-y-4">
      {appNodeSceneGroups(appOptions).map((group) => (
        <AppListGroup key={group.key} label={group.label}>
          {group.options.map((app) => (
            <AppListRow
              key={appOptionKey(app)}
              appKey={appOptionKey(app)}
              label={app.label}
              detail={app.language === 'javascript' ? 'JS' : undefined}
              onClick={() => pushFrameAppsUrl(frame, app)}
            />
          ))}
        </AppListGroup>
      ))}
    </nav>
  )
}

function AppsSelector({
  sourceMode,
  frame,
  frames,
  selectedScene,
  selectedApp,
  appOptions,
  selectedSystemApp,
  systemApps,
  openFile,
}: {
  sourceMode: AppsSourceMode
  frame: FrameType | null
  frames: FrameType[]
  selectedScene: FrameScene | null
  selectedApp: AppNodeOption | null
  appOptions: AppNodeOption[]
  selectedSystemApp: SystemAppOption | null
  systemApps: SystemAppOption[]
  /** The file open in the editor (?file=), if any; without one the app's
   * overview shows and the list keeps the side panel. */
  openFile: string | null
}): JSX.Element {
  const frameGroups = groupFramesByStatus(frames)
  const inFrameAdminMode = isInFrameAdminMode()

  return (
    <div className="space-y-4">
      {!inFrameAdminMode ? (
        <SourceModeToggle
          mode={sourceMode}
          onChange={(nextMode) => {
            if (nextMode === sourceMode) {
              return
            }
            // Either side opens on its list of apps.
            if (nextMode === 'system') {
              pushSystemAppsUrl(null)
            } else if (frame) {
              pushFrameAppsUrl(frame, null)
            } else {
              router.actions.push(urls.apps())
            }
          }}
        />
      ) : null}
      {sourceMode === 'frames' && frame && !inFrameAdminMode ? (
        <SelectionSelect
          label="Frame"
          value={frame.id}
          action={
            <FrameActionsMenu
              frame={frame}
              className="frameos-form-control flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white !px-0 !py-0 text-slate-700 shadow-none transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            />
          }
          onChange={(value) => {
            const nextFrame = frames.find((candidate) => frameIdsEqual(candidate.id, value))
            if (!nextFrame) {
              return
            }
            pushFrameAppsUrl(nextFrame, null)
          }}
        >
          {frameGroups.map((group) => (
            <optgroup key={group.key} label={group.label}>
              {group.frames.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name || frameHost(candidate)}
                </option>
              ))}
            </optgroup>
          ))}
        </SelectionSelect>
      ) : null}
      {sourceMode === 'system' && (!selectedSystemApp || !openFile) ? (
        <SystemAppList systemApps={systemApps} />
      ) : sourceMode === 'system' ? (
        <>
          <SelectionSelect
            label="App"
            value={selectedSystemApp?.keyword ?? ''}
            disabled={systemApps.length === 0}
            leading={<BackToAppListButton onClick={() => pushSystemAppsUrl(selectedSystemApp?.keyword ?? null)} />}
            onChange={(value) => pushSystemAppsUrl(value)}
          >
            {systemApps.length === 0 ? (
              <option value="">No system apps</option>
            ) : (
              systemAppOptionGroups(systemApps).map((group) => (
                <optgroup key={group.key} label={group.label}>
                  {group.options.map((option) => (
                    <option key={option.keyword} value={option.keyword}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
              ))
            )}
          </SelectionSelect>
          {selectedSystemApp ? <SystemAppFileList keyword={selectedSystemApp.keyword} /> : <EmptyFileList />}
        </>
      ) : !selectedApp || !openFile ? (
        frame ? (
          <FrameAppList frame={frame} appOptions={appOptions} />
        ) : (
          <div className="frameos-muted px-3 py-2 text-sm">Add a frame before editing its apps.</div>
        )
      ) : (
        <>
          <SelectionSelect
            label="App"
            value={selectedApp ? appOptionKey(selectedApp) : ''}
            disabled={!frame || appOptions.length === 0}
            leading={frame ? <BackToAppListButton onClick={() => pushFrameAppsUrl(frame, selectedApp)} /> : null}
            onChange={(value) => {
              const nextApp = appOptions.find((app) => appOptionKey(app) === value) ?? null
              if (frame) {
                pushFrameAppsUrl(frame, nextApp)
              }
            }}
          >
            {appOptions.length === 0 ? (
              <option value="">No apps</option>
            ) : (
              appNodeSceneGroups(appOptions).map((group) => (
                <optgroup key={group.key} label={group.label}>
                  {group.options.map((app) => (
                    <option key={appOptionKey(app)} value={appOptionKey(app)}>
                      {app.label}
                      {app.language === 'javascript' ? ' [JS]' : ''}
                    </option>
                  ))}
                </optgroup>
              ))
            )}
          </SelectionSelect>
          {selectedScene && selectedApp ? (
            <EditAppFileList
              sceneId={selectedScene.id}
              nodeId={selectedApp.nodeId}
              onSelectFile={(file) => (frame ? pushFrameAppsUrl(frame, selectedApp, file) : undefined)}
            />
          ) : (
            <EmptyFileList />
          )}
        </>
      )}
    </div>
  )
}

function AppsTopBar({
  frame,
  scene,
  app,
  unsavedChanges,
}: {
  frame: FrameType
  scene: FrameScene | null
  app: AppNodeOption | null
  unsavedChanges: boolean
}): JSX.Element {
  // A compiled Nim app in an interpreted scene is read only here, exactly
  // like the system apps page: the source is on GitHub, not in this editor.
  const { requiresCompiledOnSave } = useValues(
    editAppLogic({ frameId: frame.id, sceneId: scene?.id ?? '', nodeId: app?.nodeId ?? '' })
  )
  const readOnly = Boolean(scene && app && requiresCompiledOnSave)
  return (
    <div className="mb-4 flex flex-col items-stretch justify-between gap-4 @md:flex-row @md:items-center">
      <div className="min-w-0">
        <div className="frameos-muted text-xs font-semibold uppercase tracking-wide text-slate-400">
          {frame.name || frameHost(frame)}
          {scene ? ` / ${scene.name || 'Untitled scene'}` : ''}
          {readOnly ? ' (read only)' : ''}
        </div>
        <h1 className="frameos-strong flex min-w-0 items-center gap-2 truncate text-2xl font-bold tracking-normal text-slate-950">
          <CodeBracketIcon className="h-7 w-7 shrink-0 text-slate-400" />
          <span className="truncate">{app?.label ?? 'Apps'}</span>
        </h1>
      </div>
      <div className="apps-topbar-actions flex flex-nowrap items-center justify-start gap-2">
        {scene && app && readOnly ? (
          <>
            <BackToSceneButton frameId={frame.id} sceneId={scene.id} nodeId={app.nodeId} />
            <a
              href={systemAppGithubUrl(app.keyword)}
              target="_blank"
              rel="noreferrer"
              className="apps-topbar-action frameos-secondary-button inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            >
              <ArrowTopRightOnSquareIcon className="h-4 w-4" />
              <span>Open in GitHub</span>
            </a>
          </>
        ) : scene && app ? (
          <>
            <BackToSceneButton frameId={frame.id} sceneId={scene.id} nodeId={app.nodeId} />
            <ActiveAppDiscardButton frameId={frame.id} sceneId={scene.id} nodeId={app.nodeId} />
            <ActiveAppSaveButton
              frameId={frame.id}
              sceneId={scene.id}
              nodeId={app.nodeId}
              frameUnsavedChanges={unsavedChanges}
            />
          </>
        ) : (
          <FrameSaveButton frameId={frame.id} disabled={!unsavedChanges} />
        )}
      </div>
    </div>
  )
}

function SystemAppsTopBar({ app }: { app: SystemAppOption | null }): JSX.Element {
  return (
    <div className="mb-4 flex flex-col items-stretch justify-between gap-4 @md:flex-row @md:items-center">
      <div className="min-w-0">
        <div className="frameos-muted text-xs font-semibold uppercase tracking-wide text-slate-400">
          System apps (read only)
        </div>
        <h1 className="frameos-strong flex min-w-0 items-center gap-2 truncate text-2xl font-bold tracking-normal text-slate-950">
          <CodeBracketIcon className="h-7 w-7 shrink-0 text-slate-400" />
          <span className="truncate">{app?.label ?? 'Apps'}</span>
        </h1>
      </div>
      {app ? (
        <div className="flex flex-wrap items-center gap-2 @md:justify-end">
          <a
            href={systemAppGithubUrl(app.keyword)}
            target="_blank"
            rel="noreferrer"
            className="apps-topbar-action frameos-secondary-button inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            <ArrowTopRightOnSquareIcon className="h-4 w-4" />
            <span>Open in GitHub</span>
          </a>
        </div>
      ) : null}
    </div>
  )
}

function BackToSceneButton({
  frameId,
  sceneId,
  nodeId,
}: {
  frameId: FrameId
  sceneId: string
  nodeId: string
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => router.actions.push(urls.scenes(frameId, sceneId), { nodeId })}
      className="apps-topbar-action frameos-secondary-button inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
    >
      <ArrowLeftIcon className="h-4 w-4" />
      <span>Back to scene</span>
    </button>
  )
}

function ActiveAppDiscardButton({
  frameId,
  sceneId,
  nodeId,
}: {
  frameId: FrameId
  sceneId: string
  nodeId: string
}): JSX.Element {
  const logic = editAppLogic({ frameId, sceneId, nodeId })
  const { hasChanges } = useValues(logic)
  const { discardChanges } = useActions(logic)

  return (
    <button
      type="button"
      onClick={() => discardChanges()}
      disabled={!hasChanges}
      className="apps-topbar-action frameos-secondary-button rounded-lg px-4 py-2 text-sm font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-40"
    >
      Discard changes
    </button>
  )
}

function FrameSaveButton({ frameId, disabled }: { frameId: FrameId; disabled: boolean }): JSX.Element {
  const { saveFrame } = useActions(frameLogic({ frameId }))

  return (
    <button
      type="button"
      onClick={() => saveFrame()}
      disabled={disabled}
      className="apps-topbar-action frameos-secondary-button rounded-lg px-4 py-2 text-sm font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-40"
    >
      Save
    </button>
  )
}

function ActiveAppSaveButton({
  frameId,
  sceneId,
  nodeId,
  frameUnsavedChanges,
}: {
  frameId: FrameId
  sceneId: string
  nodeId: string
  frameUnsavedChanges: boolean
}): JSX.Element {
  const logic = editAppLogic({ frameId, sceneId, nodeId })
  const { hasChanges } = useValues(logic)
  const { saveChanges } = useActions(logic)
  const { saveFrame } = useActions(frameLogic({ frameId }))
  const disabled = !hasChanges && !frameUnsavedChanges

  return (
    <button
      type="button"
      onClick={() => {
        if (hasChanges) {
          saveChanges()
        }
        saveFrame()
      }}
      disabled={disabled}
      className={clsx(
        'apps-topbar-action rounded-lg px-4 py-2 text-sm font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-40',
        hasChanges ? 'frameos-primary-action' : 'frameos-secondary-button'
      )}
    >
      Save
    </button>
  )
}

function SystemAppFileList({ keyword }: { keyword: string }): JSX.Element {
  const logic = systemAppSourceLogic({ keyword })
  const { filenames, sourcesLoading, activeFile } = useValues(logic)
  const setActiveFile = (file: string) => pushSystemAppsUrl(keyword, file)

  if (sourcesLoading) {
    return (
      <div className="app-file-list frameos-inset rounded-2xl border p-3">
        <div className="frameos-muted mb-2 text-xs font-semibold uppercase tracking-wide">Files</div>
        <div className="app-file-row flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-semibold">
          <span className="frameos-skeleton-media h-7 w-7 shrink-0 animate-pulse rounded-lg" />
          <span className="frameos-skeleton-line h-3 w-24 animate-pulse rounded-full" />
        </div>
      </div>
    )
  }

  return (
    <div className="app-file-list frameos-inset rounded-2xl border p-3">
      <div className="frameos-muted mb-2 text-xs font-semibold uppercase tracking-wide">Files</div>
      {filenames.length === 0 ? (
        <div className="px-3 py-2 text-sm font-semibold text-slate-500">No files</div>
      ) : (
        <div className="space-y-1">
          {filenames.map((file) => (
            <button
              key={file}
              type="button"
              onClick={() => setActiveFile(file)}
              className={clsx(
                'app-file-row min-w-0 w-full truncate rounded-xl px-3 py-2 text-left text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
                activeFile === file ? 'app-file-row-active' : null
              )}
              title={file}
            >
              {file}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function formatFileSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}

// An app's overview, the way a repository's front page reads: the files
// (a click opens one in the editor), then what config.json says about the
// app — its fields, settings and outputs — as the readme. One piece for
// the system apps and a frame's own apps.
function AppOverview({
  title,
  meta,
  githubUrl,
  filenames,
  sources,
  sourcesLoading,
  configJson,
  onOpenFile,
}: {
  title: string
  meta: (string | null | undefined)[]
  githubUrl?: string | null
  filenames: string[]
  sources: Record<string, string>
  sourcesLoading: boolean
  configJson: Record<string, any> | null
  onOpenFile: (file: string) => void
}): JSX.Element {
  const fields = (Array.isArray(configJson?.fields) ? configJson.fields : []) as Record<string, any>[]
  const outputs = (Array.isArray(configJson?.output) ? configJson.output : []) as Record<string, any>[]
  const settings = (Array.isArray(configJson?.settings) ? configJson.settings : []) as string[]
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-6 pb-16">
        <div>
          <h1 className="frameos-strong text-2xl font-bold">{title}</h1>
          {configJson?.description ? (
            <p className="frameos-muted mt-1 max-w-3xl text-sm leading-relaxed">{configJson.description}</p>
          ) : null}
          <div className="frameos-muted mt-1 text-xs">{meta.filter(Boolean).join(' · ')}</div>
        </div>
        <section className="frameos-card overflow-hidden rounded-xl border">
          <div className="frameos-inset flex items-center justify-between border-b px-4 py-2 text-xs font-semibold uppercase tracking-wide">
            <span>Files</span>
            {githubUrl ? (
              <a
                href={githubUrl}
                target="_blank"
                rel="noreferrer"
                className="frameos-muted flex items-center gap-1 normal-case tracking-normal hover:underline"
              >
                Open in GitHub
                <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
              </a>
            ) : null}
          </div>
          {sourcesLoading ? (
            <div className="frameos-muted px-4 py-3 text-sm">Loading files…</div>
          ) : filenames.length === 0 ? (
            <div className="frameos-muted px-4 py-3 text-sm">No files.</div>
          ) : (
            <div className="divide-y divide-slate-500/10">
              {filenames.map((file) => (
                <button
                  key={file}
                  type="button"
                  onClick={() => onOpenFile(file)}
                  className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition hover:bg-slate-500/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                >
                  <CodeBracketIcon className="frameos-muted h-4 w-4 shrink-0" />
                  <span className="frameos-strong min-w-0 flex-1 truncate font-mono">{file}</span>
                  <span className="frameos-muted shrink-0 text-xs">{formatFileSize(sources[file]?.length ?? 0)}</span>
                </button>
              ))}
            </div>
          )}
        </section>
        <section className="frameos-card rounded-xl border p-5">
          <div className="frameos-muted mb-3 text-xs font-semibold uppercase tracking-wide">README</div>
          <div className="space-y-5 text-sm leading-relaxed">
            <div>
              <h2 className="frameos-strong text-lg font-bold">{configJson?.name || title}</h2>
              {configJson?.description ? <p className="frameos-muted mt-1">{configJson.description}</p> : null}
            </div>
            {fields.length > 0 ? (
              <div>
                <h3 className="frameos-strong mb-2 font-semibold">Fields</h3>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="frameos-muted text-left text-xs uppercase tracking-wide">
                      <th className="py-1 pr-3 font-semibold">Name</th>
                      <th className="py-1 pr-3 font-semibold">Type</th>
                      <th className="py-1 pr-3 font-semibold">Default</th>
                      <th className="py-1 font-semibold">Label</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-500/10">
                    {fields.map((field, index) => (
                      <tr key={field.name ?? index}>
                        <td className="py-1.5 pr-3 font-mono text-xs">{field.name ?? (field.markdown ? '—' : '')}</td>
                        <td className="py-1.5 pr-3 text-xs">
                          {field.type ?? (field.markdown ? 'markdown' : '')}
                          {field.required ? ' · required' : ''}
                        </td>
                        <td className="frameos-muted py-1.5 pr-3 font-mono text-xs">
                          {field.value !== undefined && field.value !== null && field.value !== ''
                            ? String(field.value)
                            : ''}
                        </td>
                        <td className="py-1.5 text-xs">{field.label ?? field.markdown ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {outputs.length > 0 ? (
              <div>
                <h3 className="frameos-strong mb-2 font-semibold">Returns</h3>
                <ul className="frameos-muted list-disc space-y-1 pl-5">
                  {outputs.map((output, index) => (
                    <li key={output.name ?? index}>
                      <span className="font-mono text-xs">{output.name}</span>
                      {output.type ? <span className="text-xs"> · {output.type}</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {settings.length > 0 ? (
              <div>
                <h3 className="frameos-strong mb-2 font-semibold">Uses service keys</h3>
                <p className="frameos-muted">{settings.join(', ')}</p>
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  )
}

function SystemAppOverview({ app }: { app: SystemAppOption }): JSX.Element {
  const logic = systemAppSourceLogic({ keyword: app.keyword })
  const { filenames, sources, sourcesLoading, configJson } = useValues(logic)
  return (
    <AppOverview
      title={app.label}
      meta={[
        app.categoryLabel,
        app.javascript ? 'JavaScript' : 'Nim',
        configJson?.version ? `v${configJson.version}` : null,
      ]}
      githubUrl={systemAppGithubUrl(app.keyword)}
      filenames={filenames}
      sources={sources}
      sourcesLoading={sourcesLoading}
      configJson={configJson}
      onOpenFile={(file) => pushSystemAppsUrl(app.keyword, file)}
    />
  )
}

// A frame's app: its sources are the scene's (editAppLogic), its readme
// the app's own config.
function FrameAppOverview({
  frame,
  scene,
  app,
}: {
  frame: FrameType
  scene: FrameScene
  app: AppNodeOption
}): JSX.Element {
  const logic = editAppLogic({ frameId: frame.id, sceneId: scene.id, nodeId: app.nodeId })
  const { filenames, sources, sourcesLoading, configJson } = useValues(logic)
  return (
    <AppOverview
      title={app.label}
      meta={[scene.name, app.language === 'javascript' ? 'JavaScript' : 'Nim', app.keyword]}
      filenames={filenames}
      sources={sources}
      sourcesLoading={sourcesLoading}
      configJson={configJson}
      onOpenFile={(file) => pushFrameAppsUrl(frame, app, file)}
    />
  )
}

function SystemAppEditorSurface({ app, file }: { app: SystemAppOption | null; file: string | null }): JSX.Element {
  if (!app) {
    return <AppsEmptyState title="No system app selected" detail="Choose a system app from the left panel." />
  }
  if (!file) {
    return <SystemAppOverview app={app} />
  }

  return (
    <div className="apps-editor-surface min-h-0 flex-1 overflow-hidden">
      <SystemAppSourceEditor keyword={app.keyword} file={file} />
    </div>
  )
}

function SystemAppSourceEditor({ keyword, file }: { keyword: string; file: string }): JSX.Element {
  const { theme } = useValues(workspaceLogic)
  const logic = systemAppSourceLogic({ keyword })
  const { sources, sourcesLoading, activeFile, appTypeDeclarations } = useValues(logic)
  const { setActiveFile } = useActions(logic)
  // The file is in the URL (?file=); the logic follows it.
  useEffect(() => {
    if (file && activeFile !== file) {
      setActiveFile(file)
    }
  }, [file, activeFile, setActiveFile])
  const [[monaco, editor], setMonacoAndEditor] = useState<[Monaco | null, importedEditor.IStandaloneCodeEditor | null]>(
    [null, null]
  )
  const appTypesLibsRef = useRef<{ dispose: () => void }[]>([])

  useEffect(() => {
    if (!monaco) {
      return
    }

    appTypesLibsRef.current.forEach((lib) => lib.dispose())
    appTypesLibsRef.current = [
      monaco.languages.typescript.typescriptDefaults.addExtraLib(
        appTypeDeclarations,
        inmemoryModelPath('system-app-editor', [keyword], 'frameos-app-typescript.d.ts')
      ),
      monaco.languages.typescript.javascriptDefaults.addExtraLib(
        appTypeDeclarations,
        inmemoryModelPath('system-app-editor', [keyword], 'frameos-app-javascript.d.ts')
      ),
    ]

    return () => {
      appTypesLibsRef.current.forEach((lib) => lib.dispose())
      appTypesLibsRef.current = []
    }
  }, [monaco, appTypeDeclarations, keyword])

  if (sourcesLoading) {
    return <div>Loading...</div>
  }

  const editorLanguage = appSourceEditorLanguage(activeFile)

  return (
    <div className="overflow-y-auto overflow-x-auto w-full h-full max-h-full max-w-full gap-2 flex-1 flex flex-col">
      {/* Self-hosted: the app becomes editable once a scene uses it. The cloud
          only runs interpreted scenes, so there is nothing to add it to —
          the "(read only)" in the heading says it all. */}
      {!isCloudMode() ? (
        <div className="app-compiled-warning rounded-2xl p-3 text-sm">
          To edit this app, first add it to a scene on a frame.
        </div>
      ) : null}
      <div className="frameos-inset overflow-hidden rounded-md border font-mono text-sm w-full flex-1">
        <Editor
          height="100%"
          path={inmemoryModelPath('system-app-editor', [keyword], activeFile)}
          language={editorLanguage}
          value={sources[activeFile] ?? sources[Object.keys(sources)[0]] ?? ''}
          theme={theme === 'dark' ? 'darkframe' : 'lightframe'}
          beforeMount={configureAppSourceEditor}
          onMount={(editor, monaco) => setMonacoAndEditor([monaco, editor])}
          options={{ minimap: { enabled: false }, readOnly: true, domReadOnly: true }}
        />
      </div>
    </div>
  )
}

function ActiveAppSelectionMount({
  frameId,
  sceneId,
  app,
}: {
  frameId: FrameId
  sceneId: string
  app: AppNodeOption
}): null {
  useMountedLogic(
    activeAppSelectionLogic({
      frameId,
      sceneId,
      nodeId: app.nodeId,
      nodeData: app.nodeData,
    })
  )
  return null
}

function FrameAppFileSync({
  frame,
  scene,
  app,
  file,
}: {
  frame: FrameType
  scene: FrameScene
  app: AppNodeOption
  file: string
}): null {
  const logic = editAppLogic({ frameId: frame.id, sceneId: scene.id, nodeId: app.nodeId })
  const { activeFile, filenames } = useValues(logic)
  const { setActiveFile } = useActions(logic)
  // The file is in the URL (?file=); the editor follows it once the
  // sources are in.
  useEffect(() => {
    if (file && activeFile !== file && filenames.includes(file)) {
      setActiveFile(file)
    }
  }, [file, activeFile, filenames, setActiveFile])
  return null
}

function AppsEditorSurface({
  frame,
  scene,
  app,
  file,
}: {
  frame: FrameType
  scene: FrameScene | null
  app: AppNodeOption | null
  file: string | null
}): JSX.Element {
  if (!scene) {
    return <AppsEmptyState title="No scene selected" detail="Choose a scene from the left panel." />
  }

  if (!app) {
    return <AppsEmptyState title="No app selected" detail="Choose an app from the left panel." />
  }

  if (!file) {
    return <FrameAppOverview frame={frame} scene={scene} app={app} />
  }

  return (
    <>
      <ActiveAppSelectionMount frameId={frame.id} sceneId={scene.id} app={app} />
      <FrameAppFileSync frame={frame} scene={scene} app={app} file={file} />
      <div className="apps-editor-surface min-h-0 flex-1 overflow-hidden">
        <EditApp
          editorKey={editAppEditorKey(scene.id, app.nodeId)}
          sceneId={scene.id}
          nodeId={app.nodeId}
          showFileList={false}
          compactWarnings
        />
      </div>
    </>
  )
}

function AppsEmptyState({ title, detail }: { title: string; detail: string }): JSX.Element {
  return (
    <div className="frameos-muted flex min-h-0 flex-1 items-center justify-center text-slate-500">
      <div className="text-center">
        <CubeTransparentIcon className="mx-auto mb-3 h-10 w-10 text-slate-300" />
        <div className="text-lg font-semibold text-slate-700">{title}</div>
        <div className="text-sm text-slate-500">{detail}</div>
      </div>
    </div>
  )
}

function AppsWorkspaceFrame({
  frameId,
  sourceMode,
  routeSceneId,
  routeNodeId,
  routeSystemAppKeyword,
  routeFile,
}: AppsWorkspaceFrameProps): JSX.Element {
  const frameLogicProps = { frameId }
  const { frame, scenes, unsavedChanges } = useValues(frameLogic(frameLogicProps))
  const { framesList } = useValues(framesModel)
  const { apps } = useValues(appsModel)
  const installedSystemApps = systemAppOptions(apps)
  const inFrameAdminMode = isInFrameAdminMode()
  const effectiveSourceMode: AppsSourceMode = inFrameAdminMode ? 'frames' : sourceMode

  if (!frame) {
    return (
      <FrameosShell mode="apps" title="Apps" tree={<div className="px-3 py-2 text-slate-400">Loading...</div>}>
        <div className="flex h-[60vh] items-center justify-center text-slate-500">Loading frame...</div>
      </FrameosShell>
    )
  }

  const appOptions = appNodeOptionsForScenes(scenes)
  const visibleAppOptions = inFrameAdminMode ? frameAdminAppOptions(appOptions) : appOptions
  const routeSceneApps = routeSceneId ? visibleAppOptions.filter((app) => app.sceneId === routeSceneId) : []
  // The route names the app (or at least the scene: its first app). Without
  // one the side panel is the list of apps and the editor its empty state;
  // nothing is picked on the user's behalf.
  const selectedApp =
    (routeSceneId && routeNodeId
      ? visibleAppOptions.find((app) => app.sceneId === routeSceneId && app.nodeId === routeNodeId)
      : null) ??
    (routeNodeId ? visibleAppOptions.find((app) => app.nodeId === routeNodeId) : null) ??
    routeSceneApps[0] ??
    null
  const selectedScene = selectedApp
    ? scenes.find((scene) => scene.id === selectedApp.sceneId) ?? null
    : routeSceneId && !inFrameAdminMode
    ? scenes.find((scene) => scene.id === routeSceneId) ?? null
    : null
  const selectedSystemApp =
    (routeSystemAppKeyword ? installedSystemApps.find((option) => option.keyword === routeSystemAppKeyword) : null) ??
    null

  return (
    <BindLogic logic={frameLogic} props={frameLogicProps}>
      <BindLogic logic={frameEditorsLogic} props={frameLogicProps}>
        <FrameosShell
          mode="apps"
          title="Apps"
          browserTitle={effectiveSourceMode === 'frames' ? frame.name || frameHost(frame) : 'Apps'}
          tree={
            <AppsSelector
              sourceMode={effectiveSourceMode}
              frame={frame}
              frames={framesList}
              selectedScene={selectedScene}
              selectedApp={selectedApp}
              appOptions={visibleAppOptions}
              selectedSystemApp={selectedSystemApp}
              systemApps={installedSystemApps}
              openFile={routeFile ?? null}
            />
          }
          topBar={
            effectiveSourceMode === 'system' ? (
              <SystemAppsTopBar app={selectedSystemApp} />
            ) : (
              <AppsTopBar frame={frame} scene={selectedScene} app={selectedApp} unsavedChanges={unsavedChanges} />
            )
          }
          chatNodeId={effectiveSourceMode === 'frames' ? selectedApp?.nodeId ?? null : null}
          showAiButton={effectiveSourceMode === 'frames'}
          mainClassName="apps-workspace-main flex h-screen flex-col overflow-hidden pb-5 pr-5 pt-5 max-lg:h-auto max-lg:overflow-visible max-lg:px-4"
          rightPanel={null}
        >
          {effectiveSourceMode === 'system' ? (
            <SystemAppEditorSurface app={selectedSystemApp} file={routeFile ?? null} />
          ) : (
            <AppsEditorSurface frame={frame} scene={selectedScene} app={selectedApp} file={routeFile ?? null} />
          )}
        </FrameosShell>
      </BindLogic>
    </BindLogic>
  )
}

function AppsWorkspaceSystemOnly({
  sourceMode,
  routeSystemAppKeyword,
  routeFile,
}: {
  sourceMode: AppsSourceMode
  routeSystemAppKeyword?: string | null
  routeFile?: string | null
}): JSX.Element {
  const { apps } = useValues(appsModel)
  const installedSystemApps = systemAppOptions(apps)
  const selectedSystemApp =
    (routeSystemAppKeyword ? installedSystemApps.find((option) => option.keyword === routeSystemAppKeyword) : null) ??
    null

  return (
    <FrameosShell
      mode="apps"
      title="Apps"
      tree={
        <AppsSelector
          sourceMode={sourceMode}
          frame={null}
          frames={[]}
          selectedScene={null}
          selectedApp={null}
          appOptions={[]}
          selectedSystemApp={selectedSystemApp}
          systemApps={installedSystemApps}
          openFile={routeFile ?? null}
        />
      }
      topBar={sourceMode === 'system' ? <SystemAppsTopBar app={selectedSystemApp} /> : null}
      showAiButton={false}
      mainClassName="apps-workspace-main flex h-screen flex-col overflow-hidden pb-5 pr-5 pt-5 max-lg:h-auto max-lg:overflow-visible max-lg:px-4"
    >
      {sourceMode === 'system' ? (
        <SystemAppEditorSurface app={selectedSystemApp} file={routeFile ?? null} />
      ) : (
        <AppsEmptyState title="No frames yet" detail="Add a frame before editing its apps." />
      )}
    </FrameosShell>
  )
}

export function AppsWorkspace({ frameId, sceneId, nodeId, keyword }: AppsWorkspaceProps): JSX.Element {
  const inFrameAdminMode = isInFrameAdminMode()
  const { location } = useValues(router)
  const routeSourceMode: AppsSourceMode =
    frameId === SYSTEM_APPS_ROUTE_TOKEN || isCloudSystemAppsPath(location.pathname) ? 'system' : 'frames'
  const sourceMode: AppsSourceMode = inFrameAdminMode ? 'frames' : routeSourceMode
  const routeSystemAppKeyword = routeSourceMode === 'system' ? decodeRouteKeyword(keyword ?? sceneId) : null
  const { searchParams } = useValues(router)
  const routeFile = typeof searchParams.file === 'string' && searchParams.file ? searchParams.file : null
  const routeFrameId = routeSourceMode === 'frames' ? frameId ?? null : null
  const routeSceneId = routeSourceMode === 'frames' ? sceneId ?? null : null
  const routeNodeId = routeSourceMode === 'frames' ? nodeId ?? null : null

  useMountedLogic(
    appsWorkspaceLogic({
      routeFrameId,
      routeSceneId: sourceMode === 'frames' ? routeSceneId : null,
      routeNodeId: sourceMode === 'frames' ? routeNodeId : null,
    })
  )
  const { selectedFrame } = useValues(workspaceLogic)
  const { activeFramesList, frames, framesList } = useValues(framesModel)
  const parsedRouteFrameId = sourceMode === 'frames' ? parseRouteFrameId(routeFrameId) : null
  const routeFrame = parsedRouteFrameId ? frames[parsedRouteFrameId] ?? null : null
  const firstFrame = routeFrame ?? selectedFrame ?? activeFramesList[0] ?? framesList[0] ?? null

  // Without a frame the system apps are all there is to browse; the Frames
  // side of the toggle stays, saying why it is empty, and toggles back.
  if (!firstFrame) {
    return (
      <AppsWorkspaceSystemOnly
        sourceMode={sourceMode}
        routeSystemAppKeyword={routeSystemAppKeyword}
        routeFile={routeFile}
      />
    )
  }

  return (
    <AppsWorkspaceFrame
      frameId={firstFrame.id}
      sourceMode={sourceMode}
      routeSceneId={sourceMode === 'frames' ? routeSceneId : null}
      routeNodeId={sourceMode === 'frames' ? routeNodeId : null}
      routeSystemAppKeyword={routeSystemAppKeyword}
      routeFile={routeFile}
    />
  )
}

export default AppsWorkspace
