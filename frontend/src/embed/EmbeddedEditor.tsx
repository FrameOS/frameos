import clsx from 'clsx'
import {
  allowedParentOrigins,
  replyTargetOrigin,
  sameOriginPreviewProxyUrl,
  setLockedParentOrigin,
} from './embedOrigins'
import copy from 'copy-to-clipboard'
import { BindLogic, useActions, useMountedLogic, useValues } from 'kea'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowsPointingInIcon,
  BoltIcon,
  ChevronDoubleRightIcon,
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

import { editAppEditorKey, frameEditorsLogic } from '../scenes/frame/frameEditorsLogic'
import { Diagram } from '../scenes/frame/panels/Diagram/Diagram'
import { diagramLogic } from '../scenes/frame/panels/Diagram/diagramLogic'
import { Button } from '../components/Button'
import { EditApp } from '../scenes/frame/panels/EditApp/EditApp'
import { EditAppModal } from '../scenes/frame/panels/EditApp/EditAppModal'
import { editAppLogic } from '../scenes/frame/panels/EditApp/editAppLogic'
import { Apps } from '../scenes/frame/panels/Apps/Apps'
import { Events } from '../scenes/frame/panels/Events/Events'
import { SceneJSON } from '../scenes/frame/panels/SceneJSON/SceneJSON'
import { SceneState } from '../scenes/frame/panels/SceneState/SceneState'
import { SceneSettings } from '../scenes/frame/panels/Scenes/SceneSettings'
import { RenameSceneModal } from '../scenes/frame/panels/Scenes/RenameSceneModal'
import { scenesLogic } from '../scenes/frame/panels/Scenes/scenesLogic'
import { livePreviewLogic } from '../scenes/frame/panels/Scenes/livePreviewLogic'
import { workspaceLogic } from '../scenes/workspace/workspaceLogic'
import { FrameScene, FrameType } from '../types'
import { embedBridge, embedFrameLogic } from './embedFrameLogic'
import { EmbedScenePreview } from './EmbedScenePreview'
import { ensurePortalRoots } from './portalRoots'
// Note: via the build alias this resolves to embedFrameLogic too; imported
// under its public name so BindLogic wires the same instance the Diagram
// dependency graph connects to.
import { frameLogic } from '../scenes/frame/frameLogic'
import { sanitizeIncomingScenes } from './sanitizeIncomingScenes'
import { SceneFileTree } from './SceneFileTree'
import { SCENE_DIAGRAM_FILE, sceneAppEntries, sceneFolderName, type SceneTemplateMetadata } from './sceneFiles'
import { sceneFileTreeLogic } from './sceneFileTreeLogic'
import { TemplateFile, type TemplateCategoryOption } from './TemplateFile'

export type { SceneTemplateMetadata, TemplateCategoryOption }

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
  /** Shifts the shown scene's diagram by (dx, dy) screen pixels — what a host
   * calls with half its column's width change to keep the diagram centred. */
  panBy: (dx: number, dy: number) => void
  /** Fits the shown scene's diagram to its column (what the toolbar's "Fit
   * to view" does) — for a host whose column just appeared or changed size
   * by a lot. */
  fitView: () => void
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
   * in the file tree (and once on init), so a host can follow the selection. */
  onSelectedSceneChanged?: (sceneId: string | null) => void
  /** Filled with the editor's imperative API while it is mounted. */
  apiRef?: { current: EmbeddedSceneEditorApi | null }
  /** The template's listing, the file tree's template.json. Without one the
   * tree shows a read-only template.json made of the first scene's name and
   * `description`. */
  template?: SceneTemplateMetadata
  /** Edits to template.json (its form, or its source). Absent: read only. */
  onTemplateChanged?: (changes: Partial<SceneTemplateMetadata>) => void
  /** The choices the template's Category field offers. */
  templateCategories?: TemplateCategoryOption[]
  /** template.json's Form view, in place of the built-in form: the host's
   * own view of the template (the store shows its scene page there). */
  templateContent?: ReactNode
  /** The file the editor opens on: the first scene's diagram (default) or
   * template.json. Read once, on the first init. */
  initialFile?: 'template' | 'diagram'
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
  // The tree's logic takes the file to open on as a prop (its reducer's
  // default), so a remount — StrictMode's, a host's — opens on it again.
  useMountedLogic(sceneFileTreeLogic({ ...logicProps, initialFile: props.initialFile }))
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
    const frame: Partial<FrameType> = {
      id: EMBED_FRAME_ID,
      // `mode` is a free string on the public prop; the editor only reads it
      // to pick the scene execution default.
      mode: (props.mode || 'rpios') as FrameType['mode'],
      width: props.width || 800,
      height: props.height || 480,
      interval: props.interval ?? 300,
      rotate: 0,
    }
    const sceneList = sanitizeIncomingScenes(props.scenes, frame)
    initEmbedFrame({ ...frame, scenes: sceneList } as any)
    const nextSceneId = props.sceneId ?? (sceneList.find((scene) => scene.default) || sceneList[0])?.id ?? null
    setSelectedSceneId(nextSceneId)
    setInitialized(true)
    // A re-init (the host swapped the scenes: another version loaded, an AI
    // build applied) leaves the diagram where it was, over nodes that may
    // now be elsewhere: fit the new set to view. The diagram honours the
    // request once reactflow has measured the new nodes (Diagram.tsx); on
    // the first init nothing is mounted yet, and the diagram's own
    // afterMount fits.
    if (nextSceneId) {
      diagramLogic.findMounted({ frameId: EMBED_FRAME_ID, sceneId: nextSceneId })?.actions.fitDiagramView()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.scenes])

  useEffect(() => {
    if (props.sceneId) {
      setSelectedSceneId(props.sceneId)
    }
  }, [props.sceneId])

  const onSelectedSceneChangedRef = useRef(props.onSelectedSceneChanged)
  onSelectedSceneChangedRef.current = props.onSelectedSceneChanged
  const selectedSceneIdRef = useRef(selectedSceneId)
  selectedSceneIdRef.current = selectedSceneId
  const { syncScene } = useActions(sceneFileTreeLogic(logicProps))
  useEffect(() => {
    onSelectedSceneChangedRef.current?.(selectedSceneId)
    if (selectedSceneId) {
      syncScene(selectedSceneId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSceneId])

  useEffect(() => {
    const apiRef = props.apiRef
    if (!apiRef) {
      return
    }
    // Only the shown scene has a diagram (and a mounted logic) to drive.
    const shownDiagram = () => {
      const sceneId = selectedSceneIdRef.current
      return sceneId ? diagramLogic.findMounted({ frameId: EMBED_FRAME_ID, sceneId }) : null
    }
    apiRef.current = {
      renameScene: (sceneId, name) => updateScene(sceneId, { name }),
      panBy: (dx, dy) => shownDiagram()?.actions.panDiagramView(dx, dy),
      fitView: () => shownDiagram()?.actions.fitDiagramView(),
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
          template={
            props.template ?? {
              name: (scenes[0]?.name || 'Untitled scene').trim(),
              description: props.description?.trim() ? props.description : null,
              category: null,
              tags: [],
              frameosVersion: null,
            }
          }
          onTemplateChanged={props.onTemplateChanged}
          templateCategories={props.templateCategories}
          templateContent={props.templateContent}
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
// Origins: in an iframe, only the parent window may send these, and only from
// an origin the host declared (`?parentOrigin=` on the iframe URL, else the
// framing document's origin from document.referrer); replies go to that origin,
// never '*'. `previewProxyUrl` is honoured only when it is same-origin with
// the editor itself.
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
  // The parent origin every reply goes to, locked on the first accepted
  // message from the parent. Stays null for the direct mount.
  const [parentOrigin, setParentOrigin] = useState<string | null>(null)

  useEffect(() => {
    const allowed = allowedParentOrigins(window.location.search, document.referrer)
    let lockedParentOrigin: string | null = null
    const onMessage = (event: MessageEvent): void => {
      const message = event.data
      if (!message || typeof message !== 'object') {
        return
      }
      const fromSelf = event.source === window
      const fromParent = window.parent !== window && event.source === window.parent
      if (!fromSelf && !fromParent) {
        return
      }
      if (fromParent) {
        if (!allowed.includes(event.origin)) {
          console.warn(
            `frameos-editor: ignoring a "${String(message.type)}" message from ${event.origin}; ` +
              (allowed.length > 0
                ? `allowed parent origins: ${allowed.join(', ')}`
                : 'no parent origin is known — load the editor with ?parentOrigin=<your origin>')
          )
          return
        }
        if (lockedParentOrigin === null) {
          lockedParentOrigin = event.origin
          setLockedParentOrigin(event.origin)
          setParentOrigin(event.origin)
        }
      }
      if (message.type === 'frameos-editor:init' && Array.isArray(message.scenes)) {
        const frame: Partial<FrameType> = {
          id: EMBED_FRAME_ID,
          mode: message.mode || 'rpios',
          width: message.width || 800,
          height: message.height || 480,
          interval: message.interval ?? 300,
          rotate: 0,
        }
        const sceneList = sanitizeIncomingScenes(message.scenes, frame)
        // Also dispatch synchronously (EmbeddedSceneEditor re-inits in an
        // effect, i.e. a tick later): a get-scenes message in the same tick
        // must already see the new scenes in the form.
        logic.actions.initEmbedFrame({ ...frame, scenes: sceneList } as any)
        setInit({
          scenes: sceneList,
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
          // Only a same-origin proxy: it sees every URL scene code fetches.
          previewProxyUrl: sameOriginPreviewProxyUrl(message.previewProxyUrl, window.location.origin),
          description: typeof message.description === 'string' ? message.description : undefined,
        })
        setSelectedSceneId(typeof message.sceneId === 'string' ? message.sceneId : undefined)
      } else if (message.type === 'frameos-editor:get-scenes') {
        window.parent?.postMessage(
          { type: 'frameos-editor:scenes', scenes: logic.values.frameForm?.scenes ?? [] },
          replyTargetOrigin(lockedParentOrigin)
        )
      } else if (message.type === 'frameos-editor:select-scene' && typeof message.sceneId === 'string') {
        setSelectedSceneId(message.sceneId)
      }
    }
    window.addEventListener('message', onMessage)
    // The ready handshake goes to every allowed parent origin (there is no
    // locked one yet); an origin we would not accept messages from never
    // hears from us at all.
    if (window.parent !== window) {
      for (const origin of allowed) {
        window.parent.postMessage({ type: 'frameos-editor:ready' }, origin)
      }
    } else {
      window.postMessage({ type: 'frameos-editor:ready' }, window.location.origin)
    }
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
        window.parent?.postMessage(
          { type: 'frameos-editor:scenes', scenes: nextScenes },
          replyTargetOrigin(parentOrigin)
        )
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
            aria-label="Close"
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
function AppFileHeader({ scene, nodeId, label }: { scene: FrameScene; nodeId: string; label: string }): JSX.Element {
  const logic = editAppLogic({ frameId: EMBED_FRAME_ID, sceneId: scene.id, nodeId })
  const { activeFile, hasChanges, requiresCompiledOnSave } = useValues(logic)
  const { saveChanges, discardChanges } = useActions(logic)
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

function EmbeddedEditorBody({
  selectedSceneId,
  setSelectedSceneId,
  scenes,
  theme,
  sceneDescription,
  showPreviewButton,
  template,
  onTemplateChanged,
  templateCategories,
  templateContent,
}: {
  selectedSceneId: string | null
  setSelectedSceneId: (sceneId: string) => void
  scenes: FrameScene[]
  theme: FrameosTheme
  sceneDescription: string | null
  showPreviewButton: boolean
  template: SceneTemplateMetadata
  onTemplateChanged?: (changes: Partial<SceneTemplateMetadata>) => void
  templateCategories?: TemplateCategoryOption[]
  templateContent?: ReactNode
}): JSX.Element {
  // Keep the preview logic (and the API keys applied to it) alive across
  // panel open/close cycles.
  useMountedLogic(livePreviewLogic({ frameId: EMBED_FRAME_ID }))
  const { shownSelection, treeOpen, builtinAppEditor } = useValues(sceneFileTreeLogic({ frameId: EMBED_FRAME_ID }))
  const { setTreeOpen, closeBuiltinApp } = useActions(sceneFileTreeLogic({ frameId: EMBED_FRAME_ID }))
  const [activePanel, setActivePanel] = useState<EmbedPanel | null>(null)
  const visiblePanels = showPreviewButton
    ? panelDefinitions
    : panelDefinitions.filter((definition) => definition.panel !== 'preview')

  const dark = theme === 'dark'
  const surface = dark ? 'bg-[#16181c] text-slate-100' : 'bg-white text-slate-900'
  const divider = dark ? 'border-slate-700' : 'border-slate-200'

  const selectedScene = scenes.find((scene) => scene.id === selectedSceneId) ?? null
  const appScene =
    shownSelection.kind === 'app' ? (scenes.find((scene) => scene.id === shownSelection.sceneId) ?? null) : null
  const appEntry =
    shownSelection.kind === 'app' && appScene
      ? (sceneAppEntries(appScene).find((entry) => entry.nodeId === shownSelection.nodeId) ?? null)
      : null

  return (
    <div
      className={clsx(
        'frameos-app-shell @container relative flex h-full overflow-hidden',
        `frameos-theme-${theme}`,
        surface
      )}
      data-testid="embedded-scene-editor"
    >
      {treeOpen ? (
        <SceneFileTree
          frameId={EMBED_FRAME_ID}
          scenes={scenes}
          selectedSceneId={selectedSceneId}
          onSelectScene={setSelectedSceneId}
          surfaceClassName={surface}
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
            {shownSelection.kind === 'template' ? (
              <FilePath parts={['template.json']} />
            ) : shownSelection.kind === 'app' && appScene && appEntry ? (
              <AppFileHeader scene={appScene} nodeId={appEntry.nodeId} label={appEntry.label} />
            ) : (
              <FilePath parts={selectedScene ? [sceneFolderName(selectedScene), SCENE_DIAGRAM_FILE] : []} />
            )}
          </div>
        </div>
        {shownSelection.kind === 'template' ? (
          <div className="min-h-0 flex-1">
            <TemplateFile
              frameId={EMBED_FRAME_ID}
              template={template}
              onChange={onTemplateChanged}
              categories={templateCategories}
              sceneCount={scenes.length}
              content={templateContent}
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
