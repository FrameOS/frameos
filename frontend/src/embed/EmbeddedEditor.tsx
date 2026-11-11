import {
  allowedParentOrigins,
  replyTargetOrigin,
  sameOriginPreviewProxyUrl,
  setLockedParentOrigin,
} from './embedOrigins'
import { BindLogic, useActions, useMountedLogic, useValues } from 'kea'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { BoltIcon, Cog6ToothIcon, PuzzlePieceIcon, ServerStackIcon, VariableIcon } from '@heroicons/react/24/outline'
import { PlayIcon } from '@heroicons/react/24/solid'

import { FrameosTheme } from '../utils/frameosTheme'

import { frameEditorsLogic } from '../scenes/frame/frameEditorsLogic'
import { diagramLogic } from '../scenes/frame/panels/Diagram/diagramLogic'
import { Apps } from '../scenes/frame/panels/Apps/Apps'
import { Events } from '../scenes/frame/panels/Events/Events'
import { SceneJSON } from '../scenes/frame/panels/SceneJSON/SceneJSON'
import { SceneState } from '../scenes/frame/panels/SceneState/SceneState'
import { withIsLayout } from '../utils/sceneLayouts'
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
import { SceneEditorBody, SceneEditorInfoPanel, type SceneEditorPanel } from './SceneEditorBody'
import { sceneAppWithFile, type SceneTemplateMetadata } from './sceneFiles'
import { sceneFileTreeLogic } from './sceneFileTreeLogic'
import { type TemplateCategoryOption, type TemplateField } from './TemplateFile'

export type { SceneTemplateMetadata, TemplateCategoryOption, TemplateField }

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
  /** Makes a scene a layout or a normal one through the editor's own form, so
   * the change streams out through onScenesChanged like a rename. */
  setSceneIsLayout: (sceneId: string, isLayout: boolean) => void
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
  /** Opens on this file of the shown scene's first app that has it
   * (`app.tsx`, say) instead of `initialFile`, when one does. Read once, on
   * the first init. */
  initialAppFile?: string
  /** Whether the file tree starts shown (default) or folded away. Read once,
   * on mount. */
  initialTreeOpen?: boolean
  /** The template.json fields the host keeps and the form edits: the store
   * keeps all but the name (default); a backend's saved scene the name and
   * description. */
  templateFields?: TemplateField[]
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
  useMountedLogic(
    sceneFileTreeLogic({ ...logicProps, initialFile: props.initialFile, initialTreeOpen: props.initialTreeOpen })
  )
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
  const { syncScene, openAppFile } = useActions(sceneFileTreeLogic(logicProps))
  // initialAppFile: once, when the first scene is shown. The pane shows the
  // file once the app's files have loaded (sceneFileTreeLogic's
  // pendingAppFile, AppFileHeader).
  const initialAppFileDoneRef = useRef(false)
  useEffect(() => {
    const file = props.initialAppFile
    if (!file || !initialized || !selectedSceneId || initialAppFileDoneRef.current) {
      return
    }
    initialAppFileDoneRef.current = true
    const scene = embedFrameLogic(logicProps).values.scenes?.find((candidate) => candidate.id === selectedSceneId)
    const nodeId = sceneAppWithFile(scene, file)
    if (nodeId) {
      openAppFile(selectedSceneId, nodeId, file)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialized, selectedSceneId])
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
      setSceneIsLayout: (sceneId, isLayout) => {
        const scene = embedFrameLogic(logicProps).values.scenes?.find((candidate) => candidate.id === sceneId)
        updateScene(sceneId, { settings: withIsLayout(scene?.settings, isLayout) })
      },
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
          templateFields={props.templateFields}
        />
      </BindLogic>
    </BindLogic>
  )
}

// The postMessage protocol (all messages are objects with a `type`):
//   parent -> editor:
//     {type: 'frameos-editor:init', scenes, sceneId?, mode?, width?, height?,
//      interval?, theme?, previewProxyUrl?, description?, template?,
//      templateFields?}
//     {type: 'frameos-editor:get-scenes'}          -> replies with :scenes
//     {type: 'frameos-editor:select-scene', sceneId}
//   editor -> parent:
//     {type: 'frameos-editor:ready'}               once listening
//     {type: 'frameos-editor:scenes', scenes}      after every edit (debounced)
//                                                  and as the :get-scenes reply
//     {type: 'frameos-editor:template', template}  after an edit to template.json
//                                                  (only when init sent a template)
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
// the Scene settings panel. `template` ({name, description, category, tags,
// frameosVersion}) makes template.json editable: the editor opens on it and
// reports every change; `templateFields` names the fields the host keeps
// (the form edits those alone).
//
// This wrapper drives EmbeddedSceneEditor from that protocol; it is what the
// iframe bundle (editor.tsx) and the direct mount (mount.tsx) render.
export function EmbeddedEditor(): JSX.Element {
  const logicProps = { frameId: EMBED_FRAME_ID }
  const logic = useMountedLogic(embedFrameLogic(logicProps))
  const [init, setInit] = useState<Omit<EmbeddedSceneEditorProps, 'onScenesChanged'> | null>(null)
  const [selectedSceneId, setSelectedSceneId] = useState<string | undefined>(undefined)
  const [template, setTemplate] = useState<SceneTemplateMetadata | null>(null)
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
          initialFile: message.template ? 'template' : undefined,
          templateFields: templateFieldsFromMessage(message.templateFields),
        })
        setTemplate(
          message.template && typeof message.template === 'object' ? templateFromMessage(message.template) : null
        )
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
      template={template ?? undefined}
      onTemplateChanged={
        template
          ? (changes) => {
              const next = { ...template, ...changes }
              setTemplate(next)
              window.parent?.postMessage(
                { type: 'frameos-editor:template', template: next },
                replyTargetOrigin(parentOrigin)
              )
            }
          : undefined
      }
      onScenesChanged={(nextScenes) => {
        window.parent?.postMessage(
          { type: 'frameos-editor:scenes', scenes: nextScenes },
          replyTargetOrigin(parentOrigin)
        )
      }}
    />
  )
}

const TEMPLATE_FIELDS: TemplateField[] = ['name', 'description', 'category', 'frameosVersion', 'tags']

function templateFieldsFromMessage(raw: unknown): TemplateField[] | undefined {
  return Array.isArray(raw)
    ? raw.filter((field): field is TemplateField => TEMPLATE_FIELDS.includes(field as TemplateField))
    : undefined
}

/** template.json as the host sent it, with every field in its type. */
function templateFromMessage(raw: Record<string, unknown>): SceneTemplateMetadata {
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)
  return {
    name: text(raw.name) ?? '',
    description: text(raw.description),
    category: text(raw.category),
    tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    frameosVersion: text(raw.frameosVersion),
  }
}

// The same panel set a frame's scene page offers, minus the ones that need a
// backend (compiled source) or a frame (the frame's own preview): the
// Preview here runs the scene in the browser.
function embedPanels(sceneDescription: string | null, showPreviewButton: boolean): SceneEditorPanel[] {
  return [
    {
      panel: 'info',
      label: 'Scene settings',
      icon: <Cog6ToothIcon className="h-5 w-5" />,
      render: (scene) => <SceneEditorInfoPanel frameId={EMBED_FRAME_ID} scene={scene} description={sceneDescription} />,
    },
    ...(showPreviewButton
      ? [
          {
            panel: 'preview',
            label: 'Preview',
            icon: <PlayIcon className="h-5 w-5" />,
            render: (scene: FrameScene) => <EmbedScenePreview frameId={EMBED_FRAME_ID} sceneId={scene.id} />,
          },
        ]
      : []),
    {
      panel: 'stateVariables',
      label: 'State variables',
      icon: <VariableIcon className="h-5 w-5" />,
      render: (scene) => <SceneState sceneId={scene.id} />,
    },
    { panel: 'apps', label: 'Apps', icon: <PuzzlePieceIcon className="h-5 w-5" />, render: () => <Apps /> },
    {
      panel: 'events',
      label: 'Events',
      icon: <BoltIcon className="h-5 w-5" />,
      render: (scene) => <Events frameId={EMBED_FRAME_ID} sceneId={scene.id} />,
    },
    {
      panel: 'json',
      label: 'JSON',
      icon: <ServerStackIcon className="h-5 w-5" />,
      render: (scene) => <SceneJSON sceneId={scene.id} />,
    },
  ]
}

function EmbeddedEditorBody({
  sceneDescription,
  showPreviewButton,
  ...props
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
  templateFields?: TemplateField[]
}): JSX.Element {
  // Keep the preview logic (and the API keys applied to it) alive across
  // panel open/close cycles.
  useMountedLogic(livePreviewLogic({ frameId: EMBED_FRAME_ID }))
  return (
    <SceneEditorBody frameId={EMBED_FRAME_ID} panels={embedPanels(sceneDescription, showPreviewButton)} {...props} />
  )
}
