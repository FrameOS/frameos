import { BindLogic, useActions, useMountedLogic, useValues } from 'kea'
import { A } from 'kea-router'
import clsx from 'clsx'
import { useState } from 'react'
import { ArrowLeftIcon, InformationCircleIcon, PlayIcon, SparklesIcon } from '@heroicons/react/24/outline'

import { framesModel } from '../../models/framesModel'
import { frameHost } from '../../decorators/frame'
import { urls } from '../../urls'
import { parseRouteFrameId } from '../../utils/frameId'
import { frameLogic } from '../frame/frameLogic'
import { frameEditorsLogic } from '../frame/frameEditorsLogic'
import { Diagram } from '../frame/panels/Diagram/Diagram'
import { EditTemplateModal } from '../frame/panels/Templates/EditTemplateModal'
import { RenameSceneModal } from '../frame/panels/Scenes/RenameSceneModal'
import { WorkspaceChatDrawer } from './FrameosShell'
import {
  SceneAppModal,
  SceneDiagramOverlay,
  SceneInfoPanel,
  ScenePreviewPanel,
  SceneSelectedNodeSync,
} from './SceneWorkspace'
import { sceneWorkspaceLogic } from './sceneWorkspaceLogic'
import { workspaceLogic } from './workspaceLogic'

// One installed scene, full screen, the way the store's scene pages open
// a scene: no rail, a bar with the way back and the scene's name, then the
// panels — Info on the left, the diagram in the middle, the live preview
// on the right, the AI assistant as a drawer. The same frame logics as the
// scenes workspace, so saving and deploying are what they are there.

type Panel = 'info' | 'preview'

function PanelToggle({
  active,
  title,
  onClick,
  children,
}: {
  active: boolean
  title: string
  onClick: () => void
  children: JSX.Element
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active}
      onClick={onClick}
      className={clsx(
        'flex h-9 w-9 items-center justify-center rounded-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
        active ? 'frameos-primary-active text-white' : 'frameos-icon-button text-slate-500 hover:bg-slate-100'
      )}
    >
      {children}
    </button>
  )
}

function SceneEditorPageBody({
  frameId,
  sceneId,
}: {
  frameId: ReturnType<typeof parseRouteFrameId> & {}
  sceneId: string
}): JSX.Element {
  const frameLogicProps = { frameId }
  const { frame, scenes, unsavedChanges } = useValues(frameLogic(frameLogicProps))
  const { saveFrame } = useActions(frameLogic(frameLogicProps))
  const { chatDrawerSelection, theme } = useValues(workspaceLogic)
  const { openChatDrawer, closeChatDrawer } = useActions(workspaceLogic)
  const [panels, setPanels] = useState<Record<Panel, boolean>>({ info: true, preview: true })
  const scene = scenes.find((candidate) => candidate.id === sceneId) ?? null
  const chatOpen = chatDrawerSelection?.frameId === frameId
  const toggle = (panel: Panel) => setPanels((current) => ({ ...current, [panel]: !current[panel] }))

  if (!frame) {
    return <div className="frameos-muted p-6 text-sm">Loading frame...</div>
  }

  return (
    <BindLogic logic={frameLogic} props={frameLogicProps}>
      <BindLogic logic={frameEditorsLogic} props={frameLogicProps}>
        <div
          className={clsx(
            'frameos-app-shell flex h-screen flex-col overflow-hidden text-slate-900',
            `frameos-theme-${theme}`
          )}
        >
          <header className="frameos-panel flex shrink-0 items-center gap-3 border-b border-white/80 bg-white/90 px-4 py-2 backdrop-blur-xl">
            <A
              href={urls.scenesHome('installed', { frame: frame.id })}
              title="Back to the installed scenes"
              className="frameos-icon-button flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100"
            >
              <ArrowLeftIcon className="h-5 w-5" />
            </A>
            <div className="min-w-0 flex-1">
              <div className="frameos-muted truncate text-xs">{frame.name || frameHost(frame)}</div>
              <div className="frameos-strong truncate text-base font-semibold">{scene?.name || 'Untitled scene'}</div>
            </div>
            <div className="flex items-center gap-1">
              <PanelToggle
                active={panels.info}
                title={panels.info ? 'Hide info' : 'Show info'}
                onClick={() => toggle('info')}
              >
                <InformationCircleIcon className="h-5 w-5" />
              </PanelToggle>
              <PanelToggle
                active={panels.preview}
                title={panels.preview ? 'Hide the preview' : 'Show the preview'}
                onClick={() => toggle('preview')}
              >
                <PlayIcon className="h-5 w-5" />
              </PanelToggle>
              <PanelToggle
                active={chatOpen}
                title={chatOpen ? 'Hide the AI assistant' : 'Show the AI assistant'}
                onClick={() => (chatOpen ? closeChatDrawer() : openChatDrawer(frame.id, sceneId, null))}
              >
                <SparklesIcon className="h-5 w-5" />
              </PanelToggle>
            </div>
            <button
              type="button"
              onClick={() => saveFrame()}
              disabled={!unsavedChanges}
              className="frameos-primary-action h-9 rounded-lg px-3 text-sm font-semibold text-white disabled:opacity-50"
            >
              Save
            </button>
          </header>
          {scene ? (
            <div className="flex min-h-0 flex-1">
              {panels.info ? (
                <aside className="frameos-panel w-80 shrink-0 overflow-y-auto border-r border-white/80 bg-white/70 p-4">
                  <SceneInfoPanel frameId={frame.id} scene={scene} />
                </aside>
              ) : null}
              <main className="scene-editor-canvas @container relative min-w-0 flex-1 overflow-hidden">
                <SceneSelectedNodeSync frameId={frame.id} sceneId={sceneId} />
                <Diagram sceneId={sceneId} showToolbar={false} />
                <SceneDiagramOverlay frameId={frame.id} frameMode={frame.mode} scene={scene} sceneId={sceneId} />
              </main>
              {panels.preview ? (
                <aside className="frameos-panel w-96 shrink-0 overflow-y-auto border-l border-white/80 bg-white/70 p-4">
                  <ScenePreviewPanel frameId={frame.id} scene={scene} />
                </aside>
              ) : null}
            </div>
          ) : (
            <div className="frameos-muted flex flex-1 items-center justify-center text-sm">
              This scene is not on the frame any more.
            </div>
          )}
          {chatOpen ? (
            <WorkspaceChatDrawer
              frameId={frame.id}
              sceneId={chatDrawerSelection?.sceneId ?? sceneId}
              nodeId={chatDrawerSelection?.nodeId ?? null}
            />
          ) : null}
        </div>
        <EditTemplateModal />
        <RenameSceneModal frameId={frame.id} />
        <SceneAppModal frameId={frame.id} />
      </BindLogic>
    </BindLogic>
  )
}

export function SceneEditorPage({ frameId, sceneId }: { frameId?: string; sceneId?: string }): JSX.Element {
  useMountedLogic(sceneWorkspaceLogic({ routeFrameId: frameId ?? null, routeSceneId: sceneId ?? null }))
  useMountedLogic(framesModel)
  const routeFrameId = parseRouteFrameId(frameId)
  if (routeFrameId === null || !sceneId) {
    return <div className="frameos-muted p-6 text-sm">No scene selected.</div>
  }
  return <SceneEditorPageBody frameId={routeFrameId} sceneId={sceneId} />
}

export default SceneEditorPage
