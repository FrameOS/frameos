import clsx from 'clsx'
import { BindLogic, useActions, useMountedLogic, useValues } from 'kea'
import { Save, Send } from 'lucide-react'
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline'

import '../../sceneWorkspace/sceneWorkspace.css'
import '../../sceneWorkspace/sceneWorkspaceSpa.css'
import { frameHost } from '../../decorators/frame'
import type { FrameId, FrameType } from '../../types'
import { isInFrameAdminMode } from '../../utils/frameAdmin'
import { frameMemoryAdvisory } from '../../utils/frameMemory'
import { singlePanelFor } from '../../sceneWorkspace/lib/scene-views'
import {
  SceneEditorBackButton,
  SceneEditorBar,
  SceneEditorPanelToggles,
  SceneEditorWorkspace,
  SceneNameTitle,
  UnsavedPill,
  shownPanels,
  useSinglePanelMode,
  type SceneEditorAction,
} from '../../sceneWorkspace/SceneEditorWorkspace'
import { urls } from '../../urls'
import { frameLogic } from '../frame/frameLogic'
import { frameEditorsLogic } from '../frame/frameEditorsLogic'
import { frameSceneEditorColumn } from './FrameSceneEditorColumn'
import { applyAiEventToFrame, sceneEditorPageLogic, scenesAsJson } from './sceneEditorPageLogic'
import { workspaceLogic } from './workspaceLogic'
import { workspaceMode } from './workspaceSurfaces'

/** An embedded frame short of memory (utils/frameMemory.ts): what the next
 * scene will run out of, under the bar. */
function FrameMemoryNotice({ frame }: { frame: FrameType }): JSX.Element | null {
  const advisory = frameMemoryAdvisory(frame.last_metrics, { cloudManaged: workspaceMode() === 'cloud' })
  if (!advisory) {
    return null
  }
  return (
    <div
      role="status"
      className={clsx(
        'flex shrink-0 items-start gap-1.5 border-b px-3 py-1.5 text-xs leading-5',
        advisory.level === 'critical'
          ? 'border-red-300 bg-red-50 text-red-900 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200'
          : 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200'
      )}
    >
      <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div>
        <span className="font-semibold">{advisory.headline}</span> <span className="opacity-90">{advisory.detail}</span>
      </div>
    </div>
  )
}

/** The frame's canvas as the scene sees it: rotated a quarter, its sides swap. */
function frameCanvasSize(frame: FrameType): { width: number; height: number } {
  const width = frame.width || 800
  const height = frame.height || 480
  return frame.rotate === 90 || frame.rotate === 270 ? { width: height, height: width } : { width, height }
}

// A frame's scene page (/scenes/:frameId/:sceneId): the scene store's
// workspace (frontend/src/sceneWorkspace — the bar, Editor · AI · Preview as
// resizable columns), over one of the frame's scenes. The bar: Back, the
// panels, the scene's name, Save and Save & push.
export function SceneEditorPage({ frameId }: { frameId: FrameId }): JSX.Element {
  const logicProps = { frameId }
  const { frame, scenes, unsavedChanges, isFrameFormSubmitting } = useValues(frameLogic(logicProps))
  const { saveFrame } = useActions(frameLogic(logicProps))
  useMountedLogic(frameEditorsLogic(logicProps))
  const { resolvedSceneId, panels, activePanel, previewScenes } = useValues(sceneEditorPageLogic(logicProps))
  const { goBack, savePushScene, renameScene, togglePanel, showInPreview } = useActions(
    sceneEditorPageLogic(logicProps)
  )
  const { theme } = useValues(workspaceLogic)
  const narrow = useSinglePanelMode()

  if (!frame) {
    return (
      <div className="frameos-scene-workspace editor-modal flex items-center justify-center">
        <div className="text-sm opacity-70">Loading the scene…</div>
      </div>
    )
  }

  const scene = scenes.find((candidate) => candidate.id === resolvedSceneId) ?? null
  const { width, height } = frameCanvasSize(frame)
  // The on-device panel: a save is applied right away, there is no push.
  const frameAdmin = isInFrameAdminMode()
  const actions: SceneEditorAction[] = [
    {
      Icon: Save,
      disabled: isFrameFormSubmitting || !unsavedChanges,
      emphasized: unsavedChanges,
      key: 'save',
      label: isFrameFormSubmitting ? 'Saving…' : 'Save',
      onSelect: () => saveFrame(),
      primary: true,
      title: frameAdmin ? 'Save the scenes to this frame; it applies them right away' : 'Save the changes',
    },
    ...(frameAdmin || !scene
      ? []
      : [
          {
            Icon: Send,
            key: 'push',
            label: 'Save & push',
            onSelect: () => savePushScene(scene.id),
            title: 'Save this scene and push it, with the scenes it shows or switches to, to the frame',
          },
        ]),
  ]

  return (
    <BindLogic logic={frameLogic} props={logicProps}>
      <BindLogic logic={frameEditorsLogic} props={logicProps}>
        {/* The SPA's shell (its theme for the editor column's own styles)
            around the workspace, a fixed full-screen layer like the store's
            modal: on one element the shell's position wins over the modal's. */}
        <div className={clsx('frameos-app-shell', `frameos-theme-${theme}`)}>
          <div
            className={clsx('frameos-scene-workspace editor-modal', `frameos-theme-${theme}`)}
            data-testid="scene-editor-page"
          >
            <SceneEditorBar actions={actions}>
              <SceneEditorBackButton label="Back" onClick={goBack} />
              <SceneEditorPanelToggles
                active={narrow ? singlePanelFor(panels, activePanel) : undefined}
                onToggle={(panel) => togglePanel(panel, narrow)}
                panels={panels}
              />
              <SceneNameTitle
                name={scene ? scene.name || 'Untitled scene' : null}
                onRename={(name) => scene && renameScene(scene.id, name)}
              />
              <span className="editor-modal__frame-name">{frame.name || frameHost(frame)}</span>
              {unsavedChanges ? <UnsavedPill label="Unsaved changes" short="Unsaved" /> : null}
            </SceneEditorBar>
            <FrameMemoryNotice frame={frame} />
            {scene ? (
              <SceneEditorWorkspace
                Editor={frameSceneEditorColumn(frameId)}
                scenes={scenesAsJson(scenes)}
                sceneId={scene.id}
                width={width}
                height={height}
                theme={theme}
                // The frame's form is the truth: the column edits it directly.
                onScenesChanged={() => {}}
                panels={shownPanels(panels, narrow, activePanel)}
                onClosePanel={(panel) => togglePanel(panel, narrow)}
                ai={{
                  getScenes: () => scenesAsJson(frameLogic(logicProps).values.scenes),
                  mode: 'existing',
                  onScenes: (event) => applyAiEventToFrame(frameId, event, resolvedSceneId),
                  onShowInPreview: ({ scenes: rendered, sceneId }) => showInPreview(rendered, sceneId, narrow),
                  settingsUrl: urls.settings(),
                  framesUrl: urls.frames(),
                  signedIn: true,
                }}
                preview={{ sceneId: null, scenes: previewScenes }}
              />
            ) : (
              <div className="editor-modal__frame editor-modal__frame--empty">
                <div className="text-sm opacity-70">
                  {scenes.length === 0 ? 'This frame has no scenes yet.' : 'No such scene on this frame.'}
                </div>
              </div>
            )}
          </div>
        </div>
      </BindLogic>
    </BindLogic>
  )
}
