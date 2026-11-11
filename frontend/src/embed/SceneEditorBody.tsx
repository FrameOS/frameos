import clsx from 'clsx'
import copy from 'copy-to-clipboard'
import { useActions, useValues } from 'kea'
import { useEffect, useState, type ReactNode } from 'react'
import {
  ArrowsPointingInIcon,
  ChevronDoubleRightIcon,
  ClipboardDocumentIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { PencilSquareIcon } from '@heroicons/react/24/solid'

import { FrameosTheme } from '../utils/frameosTheme'
import { ZoomOutArea } from '../icons/ZoomOutArea'
import { editAppEditorKey } from '../scenes/frame/frameEditorsLogic'
import { Diagram } from '../scenes/frame/panels/Diagram/Diagram'
import { diagramLogic } from '../scenes/frame/panels/Diagram/diagramLogic'
import { Button } from '../components/Button'
import { EditApp } from '../scenes/frame/panels/EditApp/EditApp'
import { EditAppModal } from '../scenes/frame/panels/EditApp/EditAppModal'
import { editAppLogic } from '../scenes/frame/panels/EditApp/editAppLogic'
import { SceneSettings } from '../scenes/frame/panels/Scenes/SceneSettings'
import { RenameSceneModal } from '../scenes/frame/panels/Scenes/RenameSceneModal'
import { scenesLogic } from '../scenes/frame/panels/Scenes/scenesLogic'
import type { FrameId, FrameScene } from '../types'
import { SceneFileTree } from './SceneFileTree'
import { SCENE_DIAGRAM_FILE, sceneAppEntries, sceneFolderName, type SceneTemplateMetadata } from './sceneFiles'
import { sceneFileTreeLogic } from './sceneFileTreeLogic'
import { TemplateFile, type TemplateCategoryOption, type TemplateField } from './TemplateFile'

/** One of the diagram's side panels: a button in the column at the right
 * edge, and the drawer it opens. The host decides the set (the store's
 * editor runs scenes in the browser, a frame's editor next to the frame). */
export interface SceneEditorPanel {
  panel: string
  label: string
  icon: JSX.Element
  render: (scene: FrameScene) => ReactNode
}

const utilityButtonClassName =
  'frameos-icon-button pointer-events-auto flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/90 bg-white/90 text-slate-500 shadow-lg shadow-slate-300/25 backdrop-blur-xl transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400'

function DiagramButtons({ frameId, sceneId }: { frameId: FrameId; sceneId: string }): JSX.Element {
  const { fitDiagramView, rearrangeCurrentScene } = useActions(diagramLogic({ frameId, sceneId }))
  return (
    <>
      <button type="button" title="Fit to view" onClick={fitDiagramView} className={utilityButtonClassName}>
        <ZoomOutArea className="h-5 w-5" />
      </button>
      <button type="button" title="Realign nodes" onClick={rearrangeCurrentScene} className={utilityButtonClassName}>
        <ArrowsPointingInIcon className="h-5 w-5" />
      </button>
    </>
  )
}

/** The Scene settings panel: the scene's name and id, a few counts, and its
 * settings form. */
export function SceneEditorInfoPanel({
  frameId,
  scene,
  description,
}: {
  frameId: FrameId
  scene: FrameScene
  description?: string | null
}): JSX.Element {
  const { renameScene } = useActions(scenesLogic({ frameId }))
  const nodes = scene.nodes ?? []
  const edges = scene.edges ?? []
  const connectedNodeIds = new Set<string>()
  edges.forEach((edge) => {
    if (edge.source) {
      connectedNodeIds.add(edge.source)
    }
    if (edge.target) {
      connectedNodeIds.add(edge.target)
    }
  })
  const stats = [
    { label: 'Nodes', value: nodes.length },
    { label: 'Edges', value: edges.length },
    { label: 'Scene apps', value: Object.keys(scene.apps ?? {}).length },
    { label: 'Fields', value: scene.fields?.length ?? 0 },
    { label: 'Disconnected', value: nodes.filter((node) => !connectedNodeIds.has(node.id)).length },
  ]

  return (
    <div className="frame-tool-panel space-y-5 @container">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="frameos-strong truncate text-lg font-bold">{scene.name || 'Untitled scene'}</div>
          <div className="mt-1 flex min-w-0 items-center gap-1.5">
            <div className="frameos-muted truncate font-mono text-xs text-slate-400">{scene.id}</div>
            <button
              type="button"
              title="Copy scene id"
              onClick={() => copy(scene.id)}
              className="frameos-icon-button flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            >
              <ClipboardDocumentIcon className="h-4 w-4" />
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={() => renameScene(scene.id)}
          className="frameos-secondary-button inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        >
          <PencilSquareIcon className="h-4 w-4" />
          <span>Rename</span>
        </button>
      </div>
      {description ? <div className="frameos-muted text-sm">{description}</div> : null}
      <div className="grid grid-cols-3 gap-2">
        {stats.map((stat) => (
          <div key={stat.label} className="frame-tool-row rounded-xl px-3 py-2">
            <div className="frame-tool-muted text-[11px] font-semibold uppercase tracking-wide">{stat.label}</div>
            <div className="frameos-strong mt-0.5 truncate text-sm font-semibold">{stat.value}</div>
          </div>
        ))}
      </div>
      <SceneSettings sceneId={scene.id} embedded />
      <RenameSceneModal frameId={frameId} />
    </div>
  )
}

function UtilityDrawer({
  panel,
  scene,
  onClose,
}: {
  panel: SceneEditorPanel
  scene: FrameScene
  onClose: () => void
}): JSX.Element {
  return (
    <div className="workspace-drawer frameos-drawer fixed bottom-5 right-[4.5rem] top-5 z-40 flex w-[430px] max-w-[calc(100vw-6rem)] overflow-hidden rounded-[24px] border border-white/80 bg-white/95 text-slate-900 shadow-2xl shadow-slate-500/30 backdrop-blur-xl">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="frameos-divider flex items-center justify-between gap-3 border-b border-slate-200/80 px-5 py-4">
          <div className="min-w-0">
            <h2 className="frameos-strong truncate text-xl font-bold tracking-normal text-slate-950">{panel.label}</h2>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="frameos-icon-button flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            <XMarkIcon className="h-6 w-6" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{panel.render(scene)}</div>
      </div>
    </div>
  )
}

/** The pane header's path: `scene / app / file`. The last part (the file)
 * keeps its width; the rest truncates first, and the whole path is the
 * tooltip. */
function FilePath({ parts, suffix }: { parts: string[]; suffix?: JSX.Element | null }): JSX.Element {
  const last = parts[parts.length - 1] ?? ''
  const prefix = parts.slice(0, -1)
  return (
    <span className="flex min-w-0 flex-1 items-center overflow-hidden font-mono text-xs" title={parts.join(' / ')}>
      {prefix.length > 0 ? (
        <span className="frameos-muted min-w-0 shrink truncate">
          {prefix.join(' / ')}
          <span className="px-1">/</span>
        </span>
      ) : null}
      <span className="min-w-0 shrink-0 truncate" style={{ maxWidth: '100%' }}>
        {last}
      </span>
      {suffix}
    </span>
  )
}

/** An app file's header: its path, whether it is unsaved, Discard and Save
 * (once a second row above the code, EditApp's toolbar). */
function AppFileHeader({
  frameId,
  scene,
  nodeId,
  label,
}: {
  frameId: FrameId
  scene: FrameScene
  nodeId: string
  label: string
}): JSX.Element {
  const logic = editAppLogic({ frameId, sceneId: scene.id, nodeId })
  const { activeFile, hasChanges, requiresCompiledOnSave, sourcesLoading, filenames } = useValues(logic)
  const { saveChanges, discardChanges, setActiveFile } = useActions(logic)
  // A file asked for before the app had its files (sceneFileTreeLogic's
  // pendingAppFile, a host's initialAppFile): shown once they are in, over
  // the load's own pick. Here, in the pane that shows the app, because the
  // tree's folders are not drawn while a narrow editor folds the tree away.
  const { pendingAppFile } = useValues(sceneFileTreeLogic({ frameId }))
  const { appFileOpened } = useActions(sceneFileTreeLogic({ frameId }))
  useEffect(() => {
    if (
      !sourcesLoading &&
      pendingAppFile &&
      pendingAppFile.sceneId === scene.id &&
      pendingAppFile.nodeId === nodeId &&
      filenames.includes(pendingAppFile.file)
    ) {
      setActiveFile(pendingAppFile.file)
      appFileOpened()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourcesLoading, pendingAppFile, filenames, scene.id, nodeId])
  return (
    <>
      <FilePath
        parts={[sceneFolderName(scene), label, ...(activeFile ? [activeFile] : [])]}
        suffix={hasChanges ? <span className="ml-1.5 shrink-0 font-sans text-xs font-semibold">(unsaved)</span> : null}
      />
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          size="tiny"
          color="secondary"
          onClick={() => discardChanges()}
          disabled={!hasChanges}
          className="!px-2 !text-xs"
        >
          Discard
        </Button>
        <Button
          size="tiny"
          color={hasChanges ? 'primary' : 'secondary'}
          onClick={() => saveChanges()}
          disabled={!hasChanges || requiresCompiledOnSave}
          className="!px-2 !text-xs"
          title={requiresCompiledOnSave ? 'Compiled Nim apps are read only here' : 'Save changes'}
        >
          Save
        </Button>
      </div>
    </>
  )
}

export interface SceneEditorBodyProps {
  /** The frame whose frameLogic / frameEditorsLogic the caller has bound. */
  frameId: FrameId
  selectedSceneId: string | null
  setSelectedSceneId: (sceneId: string) => void
  scenes: FrameScene[]
  theme: FrameosTheme
  panels: SceneEditorPanel[]
  /** The template's listing, the tree's template.json; null: no template
   * (a frame's scenes), and the tree lists the scenes alone. */
  template: SceneTemplateMetadata | null
  onTemplateChanged?: (changes: Partial<SceneTemplateMetadata>) => void
  templateCategories?: TemplateCategoryOption[]
  templateContent?: ReactNode
  /** The template.json fields the host keeps (the store's by default). */
  templateFields?: TemplateField[]
  /** The open side panel, when the host keeps it (a frame's page keeps it
   * in the URL); otherwise the body does. */
  activePanel?: string | null
  onActivePanelChange?: (panel: string | null) => void
  /** Inside a page with a bar of its own: the shell's backdrop stays inside
   * the editor (a fixed one would paint over the page's bar). */
  nested?: boolean
}

// The scene editor: the file tree on the left (template.json, every scene
// as a folder of its diagram and the apps it carries the source of), and the
// file it has open — the diagram with its side panels, an app's code, or
// template.json. The store's editor (EmbeddedSceneEditor) and a frame's
// scene page (SceneEditorPage) are both this, with their own frame logic
// bound around it.
export function SceneEditorBody({
  frameId,
  selectedSceneId,
  setSelectedSceneId,
  scenes,
  theme,
  panels,
  template,
  onTemplateChanged,
  templateCategories,
  templateContent,
  templateFields,
  activePanel: controlledPanel,
  onActivePanelChange,
  nested = false,
}: SceneEditorBodyProps): JSX.Element {
  const { shownSelection, treeOpen, builtinAppEditor } = useValues(sceneFileTreeLogic({ frameId }))
  const { setTreeOpen, closeBuiltinApp } = useActions(sceneFileTreeLogic({ frameId }))
  const [ownPanelKey, setOwnPanelKey] = useState<string | null>(null)
  const activePanelKey = onActivePanelChange ? controlledPanel ?? null : ownPanelKey
  const setActivePanelKey = (panel: string | null): void =>
    onActivePanelChange ? onActivePanelChange(panel) : setOwnPanelKey(panel)
  const activePanel = panels.find((panel) => panel.panel === activePanelKey) ?? null

  const dark = theme === 'dark'
  const surface = dark ? 'bg-[#16181c] text-slate-100' : 'bg-white text-slate-900'
  const divider = dark ? 'border-slate-700' : 'border-slate-200'

  const selectedScene = scenes.find((scene) => scene.id === selectedSceneId) ?? null
  const appScene =
    shownSelection.kind === 'app' ? scenes.find((scene) => scene.id === shownSelection.sceneId) ?? null : null
  const appEntry =
    shownSelection.kind === 'app' && appScene
      ? sceneAppEntries(appScene).find((entry) => entry.nodeId === shownSelection.nodeId) ?? null
      : null
  const showTemplate = template !== null && shownSelection.kind === 'template'

  return (
    <div
      className={clsx(
        'frameos-app-shell',
        nested ? 'frameos-app-shell--contained' : null,
        '@container relative flex h-full overflow-hidden',
        `frameos-theme-${theme}`,
        surface
      )}
      data-testid="embedded-scene-editor"
    >
      {treeOpen ? (
        <SceneFileTree
          frameId={frameId}
          scenes={scenes}
          selectedSceneId={selectedSceneId}
          onSelectScene={setSelectedSceneId}
          surfaceClassName={surface}
          showTemplate={template !== null}
        />
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className={clsx('flex h-10 shrink-0 items-center gap-2 border-b px-2', divider)}>
          {treeOpen ? null : (
            <button
              type="button"
              title="Show the files"
              aria-label="Show the files"
              onClick={() => setTreeOpen(true)}
              className="frameos-icon-button frameos-muted flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
            >
              <ChevronDoubleRightIcon className="h-4 w-4" />
            </button>
          )}
          <div className="flex min-w-0 flex-1 items-center gap-2 pl-1">
            {showTemplate ? (
              <FilePath parts={['template.json']} />
            ) : shownSelection.kind === 'app' && appScene && appEntry ? (
              <AppFileHeader frameId={frameId} scene={appScene} nodeId={appEntry.nodeId} label={appEntry.label} />
            ) : (
              <FilePath parts={selectedScene ? [sceneFolderName(selectedScene), SCENE_DIAGRAM_FILE] : []} />
            )}
          </div>
        </div>
        {showTemplate && template ? (
          <div className="min-h-0 flex-1">
            <TemplateFile
              frameId={frameId}
              template={template}
              onChange={onTemplateChanged}
              categories={templateCategories}
              sceneCount={scenes.length}
              content={templateContent}
              fields={templateFields}
            />
          </div>
        ) : shownSelection.kind === 'app' && appScene ? (
          <div className="@container min-h-0 flex-1 p-3">
            <EditApp
              key={`${appScene.id}.${shownSelection.nodeId}`}
              editorKey={editAppEditorKey(appScene.id, shownSelection.nodeId)}
              sceneId={appScene.id}
              nodeId={shownSelection.nodeId}
              showFileList={false}
            />
          </div>
        ) : (
          <div className="scene-editor-canvas scene-editor-canvas-full @container relative min-h-0 flex-1 overflow-hidden">
            {selectedSceneId ? <Diagram sceneId={selectedSceneId} /> : null}
            {selectedSceneId ? (
              <div className="scene-diagram-overlay pointer-events-none absolute inset-0 z-50">
                {/* One vertical column at the right edge: the drawer opens to its
                    left (right-[4.5rem]), so the buttons stay clickable. */}
                <div className="scene-diagram-corner-toolbar pointer-events-none absolute flex min-w-0 items-start gap-2">
                  <div className="scene-diagram-utility-buttons scene-diagram-utility-toolbar pointer-events-none flex shrink-0 flex-col items-center gap-2">
                    <DiagramButtons frameId={frameId} sceneId={selectedSceneId} />
                    <div className="h-2" />
                    {panels.map((definition) => (
                      <button
                        key={definition.panel}
                        type="button"
                        title={definition.label}
                        onClick={() => setActivePanelKey(activePanelKey === definition.panel ? null : definition.panel)}
                        className={clsx(
                          utilityButtonClassName,
                          activePanelKey === definition.panel
                            ? 'frameos-primary-active text-white'
                            : 'bg-white/90 text-slate-500'
                        )}
                      >
                        {definition.icon}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}
            {activePanel && selectedScene ? (
              <UtilityDrawer panel={activePanel} scene={selectedScene} onClose={() => setActivePanelKey(null)} />
            ) : null}
          </div>
        )}
      </div>
      {/* A built-in app is no file of the template: its "Edit app" shows it
          over the pane, as the app editor always did. */}
      {builtinAppEditor ? (
        <EditAppModal
          editor={builtinAppEditor}
          onClose={() => closeBuiltinApp(builtinAppEditor.sceneId, builtinAppEditor.nodeId ?? '')}
        />
      ) : null}
    </div>
  )
}
