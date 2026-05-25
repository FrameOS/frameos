import { BindLogic, useActions, useMountedLogic, useValues } from 'kea'
import { router } from 'kea-router'
import clsx from 'clsx'
import type { ReactNode } from 'react'
import { CodeBracketIcon, CubeTransparentIcon } from '@heroicons/react/24/outline'
import { framesModel } from '../../models/framesModel'
import { frameHost } from '../../decorators/frame'
import { urls } from '../../urls'
import type { AppNodeData, DiagramNode, FrameScene, FrameType } from '../../types'
import { FrameosShell } from './FrameosShell'
import { FrameDeployPlanDrawer } from './FrameDeployPlanDrawer'
import { FrameUnsavedChangesDrawer } from './FrameUnsavedChangesDrawer'
import { activeAppSelectionLogic } from './activeAppSelectionLogic'
import { appsWorkspaceLogic } from './appsWorkspaceLogic'
import { workspaceLogic } from './workspaceLogic'
import { frameLogic } from '../frame/frameLogic'
import { panelsLogic } from '../frame/panels/panelsLogic'
import { EditApp, EditAppFileList } from '../frame/panels/EditApp/EditApp'
import { groupFramesByStatus } from './frameStatusGroups'

interface AppsWorkspaceProps {
  frameId?: string
  sceneId?: string
  nodeId?: string
}

interface AppsWorkspaceFrameProps {
  frameId: number
  routeSceneId?: string | null
  routeNodeId?: string | null
}

interface AppNodeOption {
  nodeId: string
  label: string
  keyword: string
  nodeData: AppNodeData
}

function parseRouteFrameId(frameId?: string | null): number | null {
  if (!frameId) {
    return null
  }
  const parsed = parseInt(frameId, 10)
  return Number.isFinite(parsed) ? parsed : null
}

function appNodeOptions(scene: FrameScene | null | undefined): AppNodeOption[] {
  return (scene?.nodes ?? [])
    .filter((node): node is DiagramNode => node.type === 'app')
    .map((node) => {
      const nodeData = node.data as AppNodeData
      const keyword = nodeData.keyword ?? ''
      return {
        nodeId: node.id,
        label: nodeData.name || keyword || node.id,
        keyword,
        nodeData,
      }
    })
}

function defaultScene(frame: FrameType): FrameScene | null {
  return frame.scenes?.find((scene) => scene.default) ?? frame.scenes?.[0] ?? null
}

function defaultApp(scene: FrameScene | null | undefined): AppNodeOption | null {
  return appNodeOptions(scene)[0] ?? null
}

function pushAppsUrl(frame: FrameType, scene: FrameScene | null, app: AppNodeOption | null): void {
  router.actions.push(urls.apps(frame.id, scene?.id, app?.nodeId))
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

function AppsSelector({
  frame,
  frames,
  scenes,
  selectedScene,
  selectedApp,
  appOptions,
}: {
  frame: FrameType
  frames: FrameType[]
  scenes: FrameScene[]
  selectedScene: FrameScene | null
  selectedApp: AppNodeOption | null
  appOptions: AppNodeOption[]
}): JSX.Element {
  const { openChatDrawer } = useActions(workspaceLogic)
  const frameGroups = groupFramesByStatus(frames)

  return (
    <div className="space-y-4">
      <SelectionSelect
        label="Frame"
        value={frame.id}
        onChange={(value) => {
          const nextFrame = frames.find((candidate) => candidate.id === parseInt(value, 10))
          if (!nextFrame) {
            return
          }
          const nextScene = defaultScene(nextFrame)
          pushAppsUrl(nextFrame, nextScene, defaultApp(nextScene))
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
      <SelectionSelect
        label="Scene"
        value={selectedScene?.id ?? ''}
        disabled={scenes.length === 0}
        onChange={(value) => {
          const nextScene = scenes.find((scene) => scene.id === value) ?? null
          pushAppsUrl(frame, nextScene, defaultApp(nextScene))
        }}
      >
        {scenes.length === 0 ? (
          <option value="">No scenes</option>
        ) : (
          scenes.map((scene) => (
            <option key={scene.id} value={scene.id}>
              {scene.name || 'Untitled scene'}
            </option>
          ))
        )}
      </SelectionSelect>
      <SelectionSelect
        label="App"
        value={selectedApp?.nodeId ?? ''}
        disabled={!selectedScene || appOptions.length === 0}
        onChange={(value) => {
          const nextApp = appOptions.find((app) => app.nodeId === value) ?? null
          pushAppsUrl(frame, selectedScene, nextApp)
        }}
      >
        {appOptions.length === 0 ? (
          <option value="">No apps</option>
        ) : (
          appOptions.map((app) => (
            <option key={app.nodeId} value={app.nodeId}>
              {app.label}
            </option>
          ))
        )}
      </SelectionSelect>
      {selectedScene && selectedApp ? (
        <EditAppFileList
          sceneId={selectedScene.id}
          nodeId={selectedApp.nodeId}
          onOpenChat={() => openChatDrawer(frame.id, selectedScene.id)}
        />
      ) : (
        <div className="frameos-inset rounded-2xl border border-slate-200 bg-white/55 p-3">
          <div className="frameos-muted text-xs font-semibold uppercase tracking-wide text-slate-400">Files</div>
          <div className="mt-3 flex items-center gap-2 text-sm font-semibold text-slate-500">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white text-slate-400 shadow-sm">
              <CubeTransparentIcon className="h-4 w-4" />
            </span>
            <span className="truncate">No app selected</span>
          </div>
        </div>
      )}
    </div>
  )
}

function AppsTopBar({
  frame,
  scene,
  app,
  unsavedChanges,
  undeployedChanges,
}: {
  frame: FrameType
  scene: FrameScene | null
  app: AppNodeOption | null
  unsavedChanges: boolean
  undeployedChanges: boolean
}): JSX.Element {
  const { saveAndDeployFrame, saveFrame } = useActions(frameLogic({ frameId: frame.id }))
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
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => saveFrame()}
          className={clsx(
            'rounded-lg px-4 py-2 text-sm font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
            unsavedChanges ? 'frameos-primary-action' : 'frameos-secondary-button'
          )}
        >
          Save
        </button>
        <button
          type="button"
          onClick={() => saveAndDeployFrame()}
          className={clsx(
            'rounded-lg px-4 py-2 text-sm font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
            unsavedChanges || undeployedChanges ? 'frameos-primary-action' : 'frameos-secondary-button'
          )}
        >
          Deploy
        </button>
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
  const { openChatDrawer } = useActions(workspaceLogic)

  if (!scene) {
    return <AppsEmptyState title="No scene selected" detail="Choose a scene from the left panel." />
  }

  if (!app) {
    return <AppsEmptyState title="No app selected" detail="Choose an app from the left panel." />
  }

  return (
    <>
      <ActiveAppSelectionMount frameId={frame.id} sceneId={scene.id} app={app} />
      <div className="apps-editor-surface min-h-0 flex-1 overflow-hidden">
        <EditApp
          sceneId={scene.id}
          nodeId={app.nodeId}
          onOpenChat={() => openChatDrawer(frame.id, scene.id)}
          showFileList={false}
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

function AppsWorkspaceFrame({ frameId, routeSceneId, routeNodeId }: AppsWorkspaceFrameProps): JSX.Element {
  const frameLogicProps = { frameId }
  const { frame, scenes, unsavedChanges, undeployedChanges, deployPlanModalOpen, unsavedChangesModalOpen } = useValues(
    frameLogic(frameLogicProps)
  )
  const { framesList } = useValues(framesModel)

  if (!frame) {
    return (
      <FrameosShell mode="apps" title="Apps" tree={<div className="px-3 py-2 text-slate-400">Loading...</div>}>
        <div className="flex h-[60vh] items-center justify-center text-slate-500">Loading frame...</div>
      </FrameosShell>
    )
  }

  const selectedScene =
    (routeSceneId ? scenes.find((scene) => scene.id === routeSceneId) : null) ??
    scenes.find((scene) => scene.default) ??
    scenes[0] ??
    null
  const selectedSceneId = selectedScene?.id ?? null
  const appOptions = appNodeOptions(selectedScene)
  const selectedApp =
    (routeNodeId ? appOptions.find((app) => app.nodeId === routeNodeId) : null) ?? appOptions[0] ?? null

  return (
    <BindLogic logic={frameLogic} props={frameLogicProps}>
      <BindLogic logic={panelsLogic} props={frameLogicProps}>
        <FrameosShell
          mode="apps"
          title="Apps"
          tree={
            <AppsSelector
              frame={frame}
              frames={framesList}
              scenes={scenes}
              selectedScene={selectedScene}
              selectedApp={selectedApp}
              appOptions={appOptions}
            />
          }
          topBar={
            <AppsTopBar
              frame={frame}
              scene={selectedScene}
              app={selectedApp}
              unsavedChanges={unsavedChanges}
              undeployedChanges={undeployedChanges}
            />
          }
          mainClassName="apps-workspace-main flex h-screen flex-col overflow-hidden pb-5 pr-5 pt-5 max-lg:h-auto max-lg:overflow-visible max-lg:px-4"
          rightPanel={
            unsavedChangesModalOpen ? (
              <FrameUnsavedChangesDrawer frame={frame} />
            ) : deployPlanModalOpen ? (
              <FrameDeployPlanDrawer frame={frame} />
            ) : null
          }
        >
          <AppsEditorSurface frame={frame} scene={selectedSceneId ? selectedScene : null} app={selectedApp} />
        </FrameosShell>
      </BindLogic>
    </BindLogic>
  )
}

export function AppsWorkspace({ frameId, sceneId, nodeId }: AppsWorkspaceProps): JSX.Element {
  useMountedLogic(
    appsWorkspaceLogic({
      routeFrameId: frameId ?? null,
      routeSceneId: sceneId ?? null,
      routeNodeId: nodeId ?? null,
    })
  )
  const { selectedFrame } = useValues(workspaceLogic)
  const { activeFramesList, frames, framesList } = useValues(framesModel)
  const routeFrameId = parseRouteFrameId(frameId)
  const routeFrame = routeFrameId ? frames[routeFrameId] ?? null : null
  const firstFrame = routeFrame ?? selectedFrame ?? activeFramesList[0] ?? framesList[0] ?? null

  if (!firstFrame) {
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

  return <AppsWorkspaceFrame frameId={firstFrame.id} routeSceneId={sceneId ?? null} routeNodeId={nodeId ?? null} />
}

export default AppsWorkspace
