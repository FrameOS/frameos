import { BindLogic, useActions, useMountedLogic, useValues } from 'kea'
import { router } from 'kea-router'
import clsx from 'clsx'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeftIcon, CodeBracketIcon, CubeTransparentIcon } from '@heroicons/react/24/outline'
import Editor from '@monaco-editor/react'
import type { editor as importedEditor } from 'monaco-editor'
import type { Monaco } from '@monaco-editor/react'
import { appsModel, categoryLabels } from '../../models/appsModel'
import { framesModel } from '../../models/framesModel'
import { frameHost } from '../../decorators/frame'
import { urls } from '../../urls'
import { Panel, type AppConfig, type AppNodeData, type DiagramNode, type FrameScene, type FrameType } from '../../types'
import { FrameosShell } from './FrameosShell'
import { FrameDeployPlanDrawer } from './FrameDeployPlanDrawer'
import { FrameUnsavedChangesDrawer } from './FrameUnsavedChangesDrawer'
import { activeAppSelectionLogic } from './activeAppSelectionLogic'
import { appsWorkspaceLogic, SYSTEM_APPS_ROUTE_TOKEN } from './appsWorkspaceLogic'
import { workspaceLogic } from './workspaceLogic'
import { frameLogic } from '../frame/frameLogic'
import { panelsLogic } from '../frame/panels/panelsLogic'
import {
  appSourceEditorLanguage,
  configureAppSourceEditor,
  EditApp,
  EditAppFileList,
} from '../frame/panels/EditApp/EditApp'
import { editAppLogic } from '../frame/panels/EditApp/editAppLogic'
import { groupFramesByStatus } from './frameStatusGroups'
import {
  hasJavaScriptAppSource,
  isJavaScriptCatalogApp,
  isRepoAppKeyword,
  normalizeSceneApps,
} from '../../utils/sceneApps'
import { systemAppSourceLogic } from './systemAppSourceLogic'

interface AppsWorkspaceProps {
  frameId?: string
  sceneId?: string
  nodeId?: string
}

type AppsSourceMode = 'system' | 'frames'

interface AppsWorkspaceFrameProps {
  frameId: number
  sourceMode: AppsSourceMode
  routeSceneId?: string | null
  routeNodeId?: string | null
  routeSystemAppKeyword?: string | null
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

function parseRouteFrameId(frameId?: string | null): number | null {
  if (!frameId) {
    return null
  }
  const parsed = parseInt(frameId, 10)
  return Number.isFinite(parsed) ? parsed : null
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

function defaultApp(frame: FrameType | null): AppNodeOption | null {
  const scenes = frame?.scenes ?? []
  const defaultScene = scenes.find((scene) => scene.default) ?? scenes[0] ?? null
  return appNodeOptions(defaultScene)[0] ?? appNodeOptionsForScenes(scenes)[0] ?? null
}

function systemAppOptions(apps: Record<string, AppConfig>): SystemAppOption[] {
  return Object.entries(apps)
    .filter(([keyword, app]) => !isRepoAppKeyword(keyword) && app.category !== 'legacy')
    .map(([keyword, app]) => ({
      keyword,
      label: app.name || keyword,
      category: (app.category || 'other').toLowerCase(),
    }))
    .toSorted((a, b) => {
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
      group = { key: option.category, label: categoryLabels[option.category] ?? option.category, options: [] }
      groups.push(group)
    }
    group.options.push(option)
  }
  return groups
}

function pushFrameAppsUrl(frame: FrameType, app: AppNodeOption | null): void {
  router.actions.push(urls.apps(frame.id, app?.sceneId, app?.nodeId))
}

function pushSystemAppsUrl(keyword?: string | null): void {
  router.actions.push(urls.systemApps(keyword))
}

function SelectionSelect({
  label,
  value,
  disabled,
  onChange,
  children,
}: {
  label: string
  value: string | number
  disabled?: boolean
  onChange: (value: string) => void
  children: ReactNode
}): JSX.Element {
  return (
    <div>
      <label className="frameos-muted mb-2 block text-xs font-semibold uppercase tracking-wide">{label}</label>
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="frameos-form-control w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-800 outline-none transition disabled:cursor-not-allowed disabled:opacity-50 focus:ring-2 focus:ring-blue-400"
      >
        {children}
      </select>
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

function AppsSelector({
  sourceMode,
  frame,
  frames,
  selectedScene,
  selectedApp,
  appOptions,
  selectedSystemApp,
  systemApps,
}: {
  sourceMode: AppsSourceMode
  frame: FrameType | null
  frames: FrameType[]
  selectedScene: FrameScene | null
  selectedApp: AppNodeOption | null
  appOptions: AppNodeOption[]
  selectedSystemApp: SystemAppOption | null
  systemApps: SystemAppOption[]
}): JSX.Element {
  const frameGroups = groupFramesByStatus(frames)

  return (
    <div className="space-y-4">
      <SourceModeToggle
        mode={sourceMode}
        onChange={(nextMode) => {
          if (nextMode === sourceMode) {
            return
          }
          if (nextMode === 'system') {
            pushSystemAppsUrl(selectedSystemApp?.keyword ?? systemApps[0]?.keyword ?? null)
          } else if (frame) {
            pushFrameAppsUrl(frame, selectedApp ?? defaultApp(frame))
          } else {
            router.actions.push(urls.apps())
          }
        }}
      />
      {sourceMode === 'frames' && frame ? (
        <SelectionSelect
          label="Frame"
          value={frame.id}
          onChange={(value) => {
            const nextFrame = frames.find((candidate) => candidate.id === parseInt(value, 10))
            if (!nextFrame) {
              return
            }
            pushFrameAppsUrl(nextFrame, defaultApp(nextFrame))
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
      {sourceMode === 'system' ? (
        <>
          <SelectionSelect
            label="App"
            value={selectedSystemApp?.keyword ?? ''}
            disabled={systemApps.length === 0}
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
      ) : (
        <>
          <SelectionSelect
            label="App"
            value={selectedApp ? appOptionKey(selectedApp) : ''}
            disabled={!frame || appOptions.length === 0}
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
            <EditAppFileList sceneId={selectedScene.id} nodeId={selectedApp.nodeId} />
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
  return (
    <div className="mb-4 flex flex-col items-stretch justify-between gap-4 @md:flex-row @md:items-center">
      <div className="min-w-0">
        <div className="frameos-muted text-xs font-semibold uppercase tracking-wide text-slate-400">
          {frame.name || frameHost(frame)}
          {scene ? ` / ${scene.name || 'Untitled scene'}` : ''}
        </div>
        <h1 className="frameos-strong flex min-w-0 items-center gap-2 truncate text-2xl font-bold tracking-normal text-slate-950">
          <CodeBracketIcon className="h-7 w-7 shrink-0 text-slate-400" />
          <span className="truncate">{app?.label ?? 'Apps'}</span>
        </h1>
      </div>
      <div className="apps-topbar-actions flex flex-nowrap items-center justify-center gap-2 @md:justify-end">
        {scene && app ? (
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
        <div className="frameos-muted text-xs font-semibold uppercase tracking-wide text-slate-400">System apps</div>
        <h1 className="frameos-strong flex min-w-0 items-center gap-2 truncate text-2xl font-bold tracking-normal text-slate-950">
          <CodeBracketIcon className="h-7 w-7 shrink-0 text-slate-400" />
          <span className="truncate">{app?.label ?? 'Apps'}</span>
        </h1>
      </div>
    </div>
  )
}

function BackToSceneButton({
  frameId,
  sceneId,
  nodeId,
}: {
  frameId: number
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
  frameId: number
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

function FrameSaveButton({ frameId, disabled }: { frameId: number; disabled: boolean }): JSX.Element {
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
  frameId: number
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
  const { setActiveFile } = useActions(logic)

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

function SystemAppEditorSurface({ app }: { app: SystemAppOption | null }): JSX.Element {
  if (!app) {
    return <AppsEmptyState title="No system app selected" detail="Choose a system app from the left panel." />
  }

  return (
    <div className="apps-editor-surface min-h-0 flex-1 overflow-hidden">
      <SystemAppSourceEditor keyword={app.keyword} />
    </div>
  )
}

function SystemAppSourceEditor({ keyword }: { keyword: string }): JSX.Element {
  const { theme } = useValues(workspaceLogic)
  const logic = systemAppSourceLogic({ keyword })
  const { sources, sourcesLoading, activeFile, appTypeDeclarations } = useValues(logic)
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
        `inmemory://system-app-editor/${keyword}/frameos-app-typescript.d.ts`
      ),
      monaco.languages.typescript.javascriptDefaults.addExtraLib(
        appTypeDeclarations,
        `inmemory://system-app-editor/${keyword}/frameos-app-javascript.d.ts`
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
      <div className="app-compiled-warning rounded-2xl p-3 text-sm">
        <div className="space-y-3">To edit this app, first add it to a scene on a frame.</div>
      </div>
      <div className="frameos-inset overflow-hidden rounded-md border font-mono text-sm w-full flex-1">
        <Editor
          height="100%"
          path={`inmemory://system-app-editor/${keyword}/${activeFile}`}
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
  frameId: number
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

function AppsEditorSurface({
  frame,
  scene,
  app,
}: {
  frame: FrameType
  scene: FrameScene | null
  app: AppNodeOption | null
}): JSX.Element {
  if (!scene) {
    return <AppsEmptyState title="No scene selected" detail="Choose a scene from the left panel." />
  }

  if (!app) {
    return <AppsEmptyState title="No app selected" detail="Choose an app from the left panel." />
  }

  const appPanel = {
    panel: Panel.EditApp,
    key: `${scene.id}.${app.nodeId}`,
    title: app.nodeData.name || app.nodeData.keyword || app.nodeId,
    active: true,
    hidden: false,
    closable: true,
    metadata: {
      sceneId: scene.id,
      nodeId: app.nodeId,
      nodeData: app.nodeData,
    },
  }

  return (
    <>
      <ActiveAppSelectionMount frameId={frame.id} sceneId={scene.id} app={app} />
      <div className="apps-editor-surface min-h-0 flex-1 overflow-hidden">
        <EditApp panel={appPanel} sceneId={scene.id} nodeId={app.nodeId} showFileList={false} compactWarnings />
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
}: AppsWorkspaceFrameProps): JSX.Element {
  const frameLogicProps = { frameId }
  const { frame, scenes, unsavedChanges, deployPlanModalOpen, unsavedChangesModalOpen } = useValues(
    frameLogic(frameLogicProps)
  )
  const { framesList } = useValues(framesModel)
  const { apps } = useValues(appsModel)
  const installedSystemApps = systemAppOptions(apps)

  if (!frame) {
    return (
      <FrameosShell mode="apps" title="Apps" tree={<div className="px-3 py-2 text-slate-400">Loading...</div>}>
        <div className="flex h-[60vh] items-center justify-center text-slate-500">Loading frame...</div>
      </FrameosShell>
    )
  }

  const appOptions = appNodeOptionsForScenes(scenes)
  const routeSceneApps = routeSceneId ? appOptions.filter((app) => app.sceneId === routeSceneId) : []
  const fallbackApp = defaultApp(frame)
  const selectedApp =
    (routeSceneId && routeNodeId
      ? appOptions.find((app) => app.sceneId === routeSceneId && app.nodeId === routeNodeId)
      : null) ??
    (routeNodeId ? appOptions.find((app) => app.nodeId === routeNodeId) : null) ??
    routeSceneApps[0] ??
    fallbackApp ??
    null
  const selectedScene = selectedApp
    ? scenes.find((scene) => scene.id === selectedApp.sceneId) ?? null
    : routeSceneId
    ? scenes.find((scene) => scene.id === routeSceneId) ?? null
    : null
  const selectedSystemApp =
    (routeSystemAppKeyword ? installedSystemApps.find((option) => option.keyword === routeSystemAppKeyword) : null) ??
    installedSystemApps[0] ??
    null

  return (
    <BindLogic logic={frameLogic} props={frameLogicProps}>
      <BindLogic logic={panelsLogic} props={frameLogicProps}>
        <FrameosShell
          mode="apps"
          title="Apps"
          tree={
            <AppsSelector
              sourceMode={sourceMode}
              frame={frame}
              frames={framesList}
              selectedScene={selectedScene}
              selectedApp={selectedApp}
              appOptions={appOptions}
              selectedSystemApp={selectedSystemApp}
              systemApps={installedSystemApps}
            />
          }
          topBar={
            sourceMode === 'system' ? (
              <SystemAppsTopBar app={selectedSystemApp} />
            ) : (
              <AppsTopBar frame={frame} scene={selectedScene} app={selectedApp} unsavedChanges={unsavedChanges} />
            )
          }
          chatNodeId={sourceMode === 'frames' ? selectedApp?.nodeId ?? null : null}
          showAiButton={sourceMode === 'frames'}
          mainClassName="apps-workspace-main flex h-screen flex-col overflow-hidden pb-5 pr-5 pt-5 max-lg:h-auto max-lg:overflow-visible max-lg:px-4"
          rightPanel={
            unsavedChangesModalOpen ? (
              <FrameUnsavedChangesDrawer frame={frame} />
            ) : deployPlanModalOpen ? (
              <FrameDeployPlanDrawer frame={frame} />
            ) : null
          }
        >
          {sourceMode === 'system' ? (
            <SystemAppEditorSurface app={selectedSystemApp} />
          ) : (
            <AppsEditorSurface frame={frame} scene={selectedScene} app={selectedApp} />
          )}
        </FrameosShell>
      </BindLogic>
    </BindLogic>
  )
}

function AppsWorkspaceSystemOnly({ routeSystemAppKeyword }: { routeSystemAppKeyword?: string | null }): JSX.Element {
  const { apps } = useValues(appsModel)
  const installedSystemApps = systemAppOptions(apps)
  const selectedSystemApp =
    (routeSystemAppKeyword ? installedSystemApps.find((option) => option.keyword === routeSystemAppKeyword) : null) ??
    installedSystemApps[0] ??
    null

  return (
    <FrameosShell
      mode="apps"
      title="Apps"
      tree={
        <AppsSelector
          sourceMode="system"
          frame={null}
          frames={[]}
          selectedScene={null}
          selectedApp={null}
          appOptions={[]}
          selectedSystemApp={selectedSystemApp}
          systemApps={installedSystemApps}
        />
      }
      topBar={<SystemAppsTopBar app={selectedSystemApp} />}
      showAiButton={false}
      mainClassName="apps-workspace-main flex h-screen flex-col overflow-hidden pb-5 pr-5 pt-5 max-lg:h-auto max-lg:overflow-visible max-lg:px-4"
    >
      <SystemAppEditorSurface app={selectedSystemApp} />
    </FrameosShell>
  )
}

export function AppsWorkspace({ frameId, sceneId, nodeId }: AppsWorkspaceProps): JSX.Element {
  const sourceMode: AppsSourceMode = frameId === SYSTEM_APPS_ROUTE_TOKEN ? 'system' : 'frames'
  const routeSystemAppKeyword = sourceMode === 'system' ? decodeRouteKeyword(sceneId) : null

  useMountedLogic(
    appsWorkspaceLogic({
      routeFrameId: frameId ?? null,
      routeSceneId: sourceMode === 'frames' ? sceneId ?? null : null,
      routeNodeId: sourceMode === 'frames' ? nodeId ?? null : null,
    })
  )
  const { selectedFrame } = useValues(workspaceLogic)
  const { activeFramesList, frames, framesList } = useValues(framesModel)
  const routeFrameId = sourceMode === 'frames' ? parseRouteFrameId(frameId) : null
  const routeFrame = routeFrameId ? frames[routeFrameId] ?? null : null
  const firstFrame = routeFrame ?? selectedFrame ?? activeFramesList[0] ?? framesList[0] ?? null

  if (!firstFrame) {
    if (sourceMode === 'system') {
      return <AppsWorkspaceSystemOnly routeSystemAppKeyword={routeSystemAppKeyword} />
    }

    return (
      <FrameosShell
        mode="apps"
        title="Apps"
        subtitle="No frames"
        tree={<div className="px-3 py-2 text-slate-400">Add a frame before editing apps.</div>}
      >
        <div className="frameos-muted flex h-[60vh] items-center justify-center text-sm font-medium">
          No frames available.
        </div>
      </FrameosShell>
    )
  }

  return (
    <AppsWorkspaceFrame
      frameId={firstFrame.id}
      sourceMode={sourceMode}
      routeSceneId={sourceMode === 'frames' ? sceneId ?? null : null}
      routeNodeId={sourceMode === 'frames' ? nodeId ?? null : null}
      routeSystemAppKeyword={routeSystemAppKeyword}
    />
  )
}

export default AppsWorkspace
