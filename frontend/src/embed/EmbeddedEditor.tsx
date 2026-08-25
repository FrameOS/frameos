import clsx from 'clsx'
import copy from 'copy-to-clipboard'
import { BindLogic, useActions, useMountedLogic, useValues } from 'kea'
import { useEffect, useRef, useState } from 'react'
import {
  ArrowsPointingInIcon,
  BoltIcon,
  ClipboardDocumentIcon,
  Cog6ToothIcon,
  PuzzlePieceIcon,
  ServerStackIcon,
  VariableIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { PencilSquareIcon, PlayIcon } from '@heroicons/react/24/solid'

import { FrameosTheme } from '../utils/frameosTheme'
import { ZoomOutArea } from '../icons/ZoomOutArea'
import { Modal } from '../components/Modal'

import { frameEditorsLogic } from '../scenes/frame/frameEditorsLogic'
import { Diagram } from '../scenes/frame/panels/Diagram/Diagram'
import { diagramLogic } from '../scenes/frame/panels/Diagram/diagramLogic'
import { EditApp } from '../scenes/frame/panels/EditApp/EditApp'
import { Apps } from '../scenes/frame/panels/Apps/Apps'
import { Events } from '../scenes/frame/panels/Events/Events'
import { SceneJSON } from '../scenes/frame/panels/SceneJSON/SceneJSON'
import { SceneState } from '../scenes/frame/panels/SceneState/SceneState'
import { SceneSettings } from '../scenes/frame/panels/Scenes/SceneSettings'
import { RenameSceneModal } from '../scenes/frame/panels/Scenes/RenameSceneModal'
import { scenesLogic } from '../scenes/frame/panels/Scenes/scenesLogic'
import { livePreviewLogic } from '../scenes/frame/panels/Scenes/livePreviewLogic'
import { workspaceLogic } from '../scenes/workspace/workspaceLogic'
import { FrameScene } from '../types'
import { embedBridge, embedFrameLogic } from './embedFrameLogic'
import { EmbedScenePreview } from './EmbedScenePreview'
import { ensurePortalRoots } from './portalRoots'
// Note: via the build alias this resolves to embedFrameLogic too; imported
// under its public name so BindLogic wires the same instance the Diagram
// dependency graph connects to.
import { frameLogic } from '../scenes/frame/frameLogic'

const EMBED_FRAME_ID = 1

export interface EmbeddedSceneEditorScreenshotResult {
  ok: boolean
  error?: string
  /** When false, a failed save does not fall back to a local PNG download. */
  fallbackDownload?: boolean
}

/** What a host page can drive in the mounted editor (see `apiRef`). */
export interface EmbeddedSceneEditorApi {
  /** Renames a scene through the editor's own form: the diagram keeps its
   * layout and the change streams out through onScenesChanged. */
  renameScene: (sceneId: string, name: string) => void
}

export interface EmbeddedSceneEditorProps {
  scenes: FrameScene[]
  sceneId?: string
  mode?: string
  width?: number
  height?: number
  interval?: number
  theme?: FrameosTheme
  /** Same-origin endpoint the wasm preview routes CORS-blocked fetches through. */
  previewProxyUrl?: string
  /** Host-page description of the scene (scenes.json doesn't carry one), shown
   * in the Scene settings panel. */
  description?: string
  /** Fires (debounced) after every edit with the full scenes JSON. */
  onScenesChanged?: (scenes: FrameScene[]) => void
  /** Preview-panel screenshot handler; omit to let the editor download the
   * PNG locally (or, under the iframe/mount embeds, to let the embedding
   * page's protocol handler answer instead). */
  onSaveScreenshot?: (dataUrl: string, sceneId: string | null) => Promise<EmbeddedSceneEditorScreenshotResult>
  /** Hide the toolbar's built-in wasm Preview panel (default true). Hosts
   * with their own live preview next to the diagram pass false. */
  showPreviewButton?: boolean
  /** Fires with the scene the editor shows whenever the user switches scene
   * tabs (and once on init), so a host can follow the selection. */
  onSelectedSceneChanged?: (sceneId: string | null) => void
  /** Filled with the editor's imperative API while it is mounted. */
  apiRef?: { current: EmbeddedSceneEditorApi | null }
}

// The scene editor as a plain React component: render it inside any React
// tree (the library build at src/embed/lib.tsx externalizes react, so it uses
// the host app's copy). Scenes come in as props; edits stream out through
// onScenesChanged. Re-initializes when the `scenes` array identity changes.
export function EmbeddedSceneEditor(props: EmbeddedSceneEditorProps): JSX.Element {
  // Portal targets must exist before the first render pass (a useState
  // initializer runs exactly then).
  useState(ensurePortalRoots)
  const logicProps = { frameId: EMBED_FRAME_ID }
  useMountedLogic(embedFrameLogic(logicProps))
  const { initEmbedFrame, updateScene } = useActions(embedFrameLogic(logicProps))
  const { scenes } = useValues(embedFrameLogic(logicProps))
  const { setTheme } = useActions(workspaceLogic)
  const [initialized, setInitialized] = useState(false)
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null)
  const theme: FrameosTheme = props.theme ?? 'light'

  useEffect(() => {
    // Through workspaceLogic so the diagram, Monaco editors and panels
    // (which read workspaceLogic.theme) all follow the embedding page.
    setTheme(theme)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme])

  useEffect(() => {
    if (props.previewProxyUrl) {
      const config = ((window as any).FRAMEOS_APP_CONFIG = (window as any).FRAMEOS_APP_CONFIG || {})
      config.preview_proxy_url = props.previewProxyUrl
    }
    initEmbedFrame({
      id: EMBED_FRAME_ID,
      scenes: props.scenes,
      mode: props.mode || 'rpios',
      width: props.width || 800,
      height: props.height || 480,
      interval: props.interval ?? 300,
      rotate: 0,
    } as any)
    setSelectedSceneId(
      props.sceneId ?? (props.scenes.find((scene) => scene.default) || props.scenes[0])?.id ?? null
    )
    setInitialized(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.scenes])

  useEffect(() => {
    if (props.sceneId) {
      setSelectedSceneId(props.sceneId)
    }
  }, [props.sceneId])

  const onSelectedSceneChangedRef = useRef(props.onSelectedSceneChanged)
  onSelectedSceneChangedRef.current = props.onSelectedSceneChanged
  useEffect(() => {
    onSelectedSceneChangedRef.current?.(selectedSceneId)
  }, [selectedSceneId])

  useEffect(() => {
    const apiRef = props.apiRef
    if (!apiRef) {
      return
    }
    apiRef.current = {
      renameScene: (sceneId, name) => updateScene(sceneId, { name }),
    }
    return () => {
      apiRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.apiRef])

  useEffect(() => {
    if (!props.onScenesChanged) {
      return
    }
    embedBridge.onScenesChanged = props.onScenesChanged
    return () => {
      if (embedBridge.onScenesChanged === props.onScenesChanged) {
        embedBridge.onScenesChanged = undefined
      }
    }
  }, [props.onScenesChanged])

  // The Preview panel reports screenshots over the same-window message bus
  // (see EmbedScenePreview); when the host passes a handler, answer here so
  // it never has to know about the protocol.
  useEffect(() => {
    const onSaveScreenshot = props.onSaveScreenshot
    if (!onSaveScreenshot) {
      return
    }
    const onMessage = (event: MessageEvent): void => {
      const message = event.data
      if (
        event.source === window &&
        message &&
        typeof message === 'object' &&
        message.type === 'frameos-editor:save-screenshot' &&
        typeof message.dataUrl === 'string'
      ) {
        void onSaveScreenshot(message.dataUrl, typeof message.sceneId === 'string' ? message.sceneId : null)
          .catch((error): EmbeddedSceneEditorScreenshotResult => ({ ok: false, error: String(error) }))
          .then((result) => {
            window.postMessage({ type: 'frameos-editor:screenshot-saved', ...result }, window.location.origin)
          })
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [props.onSaveScreenshot])

  if (!initialized) {
    return <div className="h-full" />
  }

  return (
    <BindLogic logic={frameLogic} props={logicProps}>
      <BindLogic logic={frameEditorsLogic} props={logicProps}>
        <EmbeddedEditorBody
          selectedSceneId={selectedSceneId}
          setSelectedSceneId={setSelectedSceneId}
          scenes={scenes}
          theme={theme}
          sceneDescription={props.description?.trim() ? props.description : null}
          showPreviewButton={props.showPreviewButton ?? true}
        />
      </BindLogic>
    </BindLogic>
  )
}

// The postMessage protocol (all messages are objects with a `type`):
//   parent -> editor:
//     {type: 'frameos-editor:init', scenes, sceneId?, mode?, width?, height?,
//      interval?, theme?, previewProxyUrl?, description?}
//     {type: 'frameos-editor:get-scenes'}          -> replies with :scenes
//     {type: 'frameos-editor:select-scene', sceneId}
//   editor -> parent:
//     {type: 'frameos-editor:ready'}               once listening
//     {type: 'frameos-editor:scenes', scenes}      after every edit (debounced)
//                                                  and as the :get-scenes reply
//     {type: 'frameos-editor:save-screenshot', dataUrl, sceneId}
//                                                  Preview panel screenshot; reply with
//                                                  {type: 'frameos-editor:screenshot-saved', ok,
//                                                   error?, fallbackDownload?} or the editor
//                                                  downloads the PNG locally after a timeout
// `previewProxyUrl` is an optional same-origin endpoint the wasm live preview
// routes CORS-blocked HTTP requests through. `description` is the embedding
// page's description of the scene (scenes.json doesn't carry one), shown in
// the Scene settings panel.
//
// This wrapper drives EmbeddedSceneEditor from that protocol; it is what the
// iframe bundle (editor.tsx) and the direct mount (mount.tsx) render.
export function EmbeddedEditor(): JSX.Element {
  const logicProps = { frameId: EMBED_FRAME_ID }
  const logic = useMountedLogic(embedFrameLogic(logicProps))
  const [init, setInit] = useState<Omit<EmbeddedSceneEditorProps, 'onScenesChanged'> | null>(null)
  const [selectedSceneId, setSelectedSceneId] = useState<string | undefined>(undefined)

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const message = event.data
      if (!message || typeof message !== 'object') {
        return
      }
      if (message.type === 'frameos-editor:init' && Array.isArray(message.scenes)) {
        // Also dispatch synchronously (EmbeddedSceneEditor re-inits in an
        // effect, i.e. a tick later): a get-scenes message in the same tick
        // must already see the new scenes in the form.
        logic.actions.initEmbedFrame({
          id: EMBED_FRAME_ID,
          scenes: message.scenes,
          mode: message.mode || 'rpios',
          width: message.width || 800,
          height: message.height || 480,
          interval: message.interval ?? 300,
          rotate: 0,
        } as any)
        setInit({
          scenes: message.scenes,
          mode: message.mode,
          width: message.width,
          height: message.height,
          interval: message.interval,
          theme:
            message.theme === 'dark' || message.theme === 'light'
              ? message.theme
              : document.documentElement.dataset.frameosTheme === 'dark'
              ? 'dark'
              : 'light',
          previewProxyUrl: typeof message.previewProxyUrl === 'string' ? message.previewProxyUrl : undefined,
          description: typeof message.description === 'string' ? message.description : undefined,
        })
        setSelectedSceneId(typeof message.sceneId === 'string' ? message.sceneId : undefined)
      } else if (message.type === 'frameos-editor:get-scenes') {
        window.parent?.postMessage({ type: 'frameos-editor:scenes', scenes: logic.values.frameForm?.scenes ?? [] }, '*')
      } else if (message.type === 'frameos-editor:select-scene' && typeof message.sceneId === 'string') {
        setSelectedSceneId(message.sceneId)
      }
    }
    window.addEventListener('message', onMessage)
    window.parent?.postMessage({ type: 'frameos-editor:ready' }, '*')
    return () => window.removeEventListener('message', onMessage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!init) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-400">
        Waiting for scenes… (post a {'{type: "frameos-editor:init", scenes: [...]}'} message)
      </div>
    )
  }

  return (
    <EmbeddedSceneEditor
      {...init}
      sceneId={selectedSceneId}
      onScenesChanged={(nextScenes) => {
        window.parent?.postMessage({ type: 'frameos-editor:scenes', scenes: nextScenes }, '*')
      }}
    />
  )
}

type EmbedPanel = 'info' | 'preview' | 'stateVariables' | 'apps' | 'events' | 'json'

interface EmbedPanelDefinition {
  panel: EmbedPanel
  label: string
  icon: JSX.Element
}

// The same panel set the main app's scene workspace offers, minus the ones
// that need a backend (compiled source, AI chat) or a frame (frame preview).
const panelDefinitions: EmbedPanelDefinition[] = [
  { panel: 'info', label: 'Scene settings', icon: <Cog6ToothIcon className="h-5 w-5" /> },
  { panel: 'preview', label: 'Preview', icon: <PlayIcon className="h-5 w-5" /> },
  { panel: 'stateVariables', label: 'State variables', icon: <VariableIcon className="h-5 w-5" /> },
  { panel: 'apps', label: 'Apps', icon: <PuzzlePieceIcon className="h-5 w-5" /> },
  { panel: 'events', label: 'Events', icon: <BoltIcon className="h-5 w-5" /> },
  { panel: 'json', label: 'JSON', icon: <ServerStackIcon className="h-5 w-5" /> },
]

const utilityButtonClassName =
  'frameos-icon-button pointer-events-auto flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/90 bg-white/90 text-slate-500 shadow-lg shadow-slate-300/25 backdrop-blur-xl transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400'

function EmbedDiagramButtons({ sceneId }: { sceneId: string }): JSX.Element {
  const { fitDiagramView, rearrangeCurrentScene } = useActions(diagramLogic({ frameId: EMBED_FRAME_ID, sceneId }))
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

function EmbedSceneInfoPanel({ scene, description }: { scene: FrameScene; description: string | null }): JSX.Element {
  const { renameScene } = useActions(scenesLogic({ frameId: EMBED_FRAME_ID }))
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
      <RenameSceneModal frameId={EMBED_FRAME_ID} />
    </div>
  )
}

function EmbedUtilityDrawer({
  panel,
  scene,
  sceneDescription,
  onClose,
}: {
  panel: EmbedPanel
  scene: FrameScene
  sceneDescription: string | null
  onClose: () => void
}): JSX.Element {
  const definition = panelDefinitions.find((candidate) => candidate.panel === panel)

  const renderPanel = (): JSX.Element | null => {
    switch (panel) {
      case 'info':
        return <EmbedSceneInfoPanel scene={scene} description={sceneDescription} />
      case 'preview':
        return <EmbedScenePreview frameId={EMBED_FRAME_ID} sceneId={scene.id} />
      case 'stateVariables':
        return <SceneState sceneId={scene.id} />
      case 'apps':
        return <Apps />
      case 'events':
        return <Events frameId={EMBED_FRAME_ID} sceneId={scene.id} />
      case 'json':
        return <SceneJSON sceneId={scene.id} />
      default:
        return null
    }
  }

  return (
    <div className="workspace-drawer frameos-drawer fixed bottom-5 right-[4.5rem] top-5 z-40 flex w-[430px] max-w-[calc(100vw-6rem)] overflow-hidden rounded-[24px] border border-white/80 bg-white/95 text-slate-900 shadow-2xl shadow-slate-500/30 backdrop-blur-xl">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="frameos-divider flex items-center justify-between gap-3 border-b border-slate-200/80 px-5 py-4">
          <div className="min-w-0">
            <h2 className="frameos-strong truncate text-xl font-bold tracking-normal text-slate-950">
              {definition?.label}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="frameos-icon-button flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            <XMarkIcon className="h-6 w-6" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{renderPanel()}</div>
      </div>
    </div>
  )
}

function EmbeddedEditorBody({
  selectedSceneId,
  setSelectedSceneId,
  scenes,
  theme,
  sceneDescription,
  showPreviewButton,
}: {
  selectedSceneId: string | null
  setSelectedSceneId: (sceneId: string) => void
  scenes: FrameScene[]
  theme: FrameosTheme
  sceneDescription: string | null
  showPreviewButton: boolean
}): JSX.Element {
  const { activeEditor } = useValues(frameEditorsLogic({ frameId: EMBED_FRAME_ID }))
  const { closeEditor } = useActions(frameEditorsLogic({ frameId: EMBED_FRAME_ID }))
  // Keep the preview logic (and the API keys applied to it) alive across
  // panel open/close cycles.
  useMountedLogic(livePreviewLogic({ frameId: EMBED_FRAME_ID }))
  const [activePanel, setActivePanel] = useState<EmbedPanel | null>(null)
  const appEditor = activeEditor?.kind === 'editApp' ? activeEditor : null
  const visiblePanels = showPreviewButton
    ? panelDefinitions
    : panelDefinitions.filter((definition) => definition.panel !== 'preview')

  const dark = theme === 'dark'
  const surface = dark ? 'bg-[#16181c] text-slate-100' : 'bg-white text-slate-900'
  const divider = dark ? 'border-slate-700' : 'border-slate-200'
  const mutedButton = dark
    ? 'rounded px-3 py-1 text-sm text-slate-400 hover:bg-slate-800'
    : 'rounded px-3 py-1 text-sm text-slate-500 hover:bg-slate-100'

  const selectedScene = scenes.find((scene) => scene.id === selectedSceneId) ?? null

  return (
    <div
      className={clsx('frameos-app-shell flex h-full flex-col overflow-hidden', `frameos-theme-${theme}`, surface)}
    >
      {scenes.length > 1 ? (
        <div className={clsx('flex shrink-0 items-center gap-1 overflow-x-auto border-b px-2 py-1', divider)}>
          {scenes.map((scene) => (
            <button
              key={scene.id}
              type="button"
              onClick={() => setSelectedSceneId(scene.id)}
              className={
                scene.id === selectedSceneId
                  ? clsx('rounded px-3 py-1 text-sm font-semibold', dark ? 'bg-slate-700' : 'bg-slate-200')
                  : mutedButton
              }
            >
              {scene.name || scene.id}
            </button>
          ))}
        </div>
      ) : null}
      <div className="scene-editor-canvas scene-editor-canvas-full @container relative min-h-0 flex-1 overflow-hidden">
        {selectedSceneId ? <Diagram sceneId={selectedSceneId} showToolbar={false} /> : null}
        {selectedSceneId ? (
          <div className="scene-diagram-overlay pointer-events-none absolute inset-0 z-50">
            {/* One vertical column at the right edge: the drawer opens to its
                left (right-[4.5rem]), so the buttons stay clickable. */}
            <div className="scene-diagram-corner-toolbar pointer-events-none absolute flex min-w-0 items-start gap-2">
              <div className="scene-diagram-utility-buttons scene-diagram-utility-toolbar pointer-events-none flex shrink-0 flex-col items-center gap-2">
                <EmbedDiagramButtons sceneId={selectedSceneId} />
                <div className="h-2" />
                {visiblePanels.map((definition) => (
                  <button
                    key={definition.panel}
                    type="button"
                    title={definition.label}
                    onClick={() =>
                      setActivePanel((current) => (current === definition.panel ? null : definition.panel))
                    }
                    className={clsx(
                      utilityButtonClassName,
                      activePanel === definition.panel
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
        {activePanel && selectedScene && (showPreviewButton || activePanel !== 'preview') ? (
          <EmbedUtilityDrawer
            panel={activePanel}
            scene={selectedScene}
            sceneDescription={sceneDescription}
            onClose={() => setActivePanel(null)}
          />
        ) : null}
      </div>
      {appEditor ? (
        <Modal
          open
          onClose={() => closeEditor(appEditor.key)}
          title={appEditor.title || 'Edit app source'}
          panelClassName="max-w-[min(1200px,calc(100vw-2rem))]"
          bodyClassName="h-[calc(100dvh-11rem)]"
        >
          <div className="h-full min-h-0 overflow-hidden">
            <EditApp editorKey={appEditor.key} sceneId={appEditor.sceneId} nodeId={appEditor.nodeId ?? ''} />
          </div>
        </Modal>
      ) : null}
    </div>
  )
}
