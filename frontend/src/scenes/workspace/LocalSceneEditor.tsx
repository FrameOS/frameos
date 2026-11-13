import clsx from 'clsx'
import { useActions, useValues } from 'kea'
import { Save } from 'lucide-react'
import { useEffect, useRef, useState, type ComponentType } from 'react'

import '../../sceneWorkspace/sceneWorkspace.css'
import '../../sceneWorkspace/sceneWorkspaceSpa.css'
import { Spinner } from '../../components/Spinner'
import { getBasePath } from '../../utils/getBasePath'
import { singlePanelFor } from '../../sceneWorkspace/lib/scene-views'
import type { SceneJson } from '../../sceneWorkspace/lib/ai-scenes-apply'
import {
  SceneEditorBackButton,
  SceneEditorBar,
  SceneEditorPanelToggles,
  SceneEditorWorkspace,
  SceneNameTitle,
  UnsavedPill,
  sceneNameFor,
  shownPanels,
  useSinglePanelMode,
  type SceneEditorAction,
  type SceneWorkspaceEditorProps,
} from '../../sceneWorkspace/SceneEditorWorkspace'
import { urls } from '../../urls'
import { applyAiEventToTemplate, localSceneEditorLogic } from './localSceneEditorLogic'

/** The editor bundle (frontend/dist-editor), served by the backend. */
function editorBundleUrl(): string {
  const url = new URL(getBasePath() + '/frameos-editor/index.html', window.location.origin)
  url.searchParams.set('parentOrigin', window.location.origin)
  return url.pathname + url.search
}

// The workspace's editor column for a saved scene: the editor bundle in an
// iframe (it needs no frame and no backend), driven over its postMessage
// protocol (frameos/editor/README.md) — what the store's EmbeddedSceneEditor
// takes as props, as messages. A new `scenes` (the AI's) re-inits it.
function LocalTemplateEditor({
  templateId,
  ...props
}: SceneWorkspaceEditorProps & { templateId: string }): JSX.Element {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const readyRef = useRef(false)
  // The editor says nothing: what is at /frameos-editor/ is not the editor
  // (not built, or a dev server without the proxy) — said, not left blank.
  const [stalled, setStalled] = useState(false)
  // template.json as the editor last had it: its reports carry the whole
  // file, and only what changed in it may reach the draft (a rename in the
  // bar is not undone by the next description edit).
  const editorTemplateRef = useRef<Record<string, unknown> | null>(null)
  const propsRef = useRef(props)
  propsRef.current = props
  const { setEditorWindow } = useActions(localSceneEditorLogic({ templateId }))

  const post = (message: Record<string, unknown>): void => {
    iframeRef.current?.contentWindow?.postMessage(message, window.location.origin)
  }
  const init = (): void => {
    const current = propsRef.current
    editorTemplateRef.current = (current.template as Record<string, unknown> | undefined) ?? null
    post({
      type: 'frameos-editor:init',
      scenes: current.scenes,
      sceneId: current.sceneId,
      width: current.width,
      height: current.height,
      theme: current.theme,
      template: current.template,
      templateFields: current.templateFields,
    })
  }

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const editorWindow = iframeRef.current?.contentWindow
      if (!editorWindow || event.source !== editorWindow || event.origin !== window.location.origin) {
        return
      }
      const message = event.data
      if (!message || typeof message !== 'object') {
        return
      }
      if (message.type === 'frameos-editor:ready') {
        readyRef.current = true
        setStalled(false)
        init()
      } else if (message.type === 'frameos-editor:scenes' && Array.isArray(message.scenes)) {
        propsRef.current.onScenesChanged?.(message.scenes)
      } else if (
        message.type === 'frameos-editor:template' &&
        message.template &&
        typeof message.template === 'object'
      ) {
        const next = message.template as Record<string, unknown>
        const previous = editorTemplateRef.current ?? {}
        editorTemplateRef.current = next
        const changes = Object.fromEntries(
          Object.entries(next).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(previous[key]))
        )
        if (Object.keys(changes).length > 0) {
          propsRef.current.onTemplateChanged?.(changes)
        }
      }
    }
    window.addEventListener('message', onMessage)
    const stallTimer = window.setTimeout(() => setStalled(!readyRef.current), 15000)
    return () => {
      window.removeEventListener('message', onMessage)
      window.clearTimeout(stallTimer)
      setEditorWindow(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The AI delivered scenes: the editor starts over from them.
  useEffect(() => {
    if (readyRef.current) {
      init()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.scenes])

  return (
    <div className="relative h-full w-full">
      <iframe
        ref={(iframe) => {
          iframeRef.current = iframe
          setEditorWindow(iframe?.contentWindow ?? null)
        }}
        src={editorBundleUrl()}
        title="Scene editor"
        className="h-full w-full border-0"
      />
      {stalled ? (
        <div className="notice notice-error absolute inset-x-4 top-4" role="alert">
          The scene editor did not load from <code>/frameos-editor/</code>. Build it with{' '}
          <code>pnpm --dir frontend run build:esbuild</code> (in development, the <code>editor</code> pane of{' '}
          <code>pnpm dev</code> keeps it built, and Vite must be restarted once to proxy it).
        </div>
      ) : null}
    </div>
  )
}

const columns = new Map<string, ComponentType<SceneWorkspaceEditorProps>>()

function localTemplateEditorColumn(templateId: string): ComponentType<SceneWorkspaceEditorProps> {
  let column = columns.get(templateId)
  if (!column) {
    column = function LocalTemplateEditorColumn(props: SceneWorkspaceEditorProps): JSX.Element {
      return <LocalTemplateEditor templateId={templateId} {...props} />
    }
    columns.set(templateId, column)
  }
  return column
}

// A backend's saved scene (the local scenes page's Edit) in the scene store's
// workspace: the bar (Back, Editor · AI · Preview, the scene's name, Save)
// and the panels as columns, the editor holding template.json (its name and
// description) and every scene the template carries.
export function LocalSceneEditor({ templateId }: { templateId?: string }): JSX.Element {
  const id = templateId ?? ''
  const logic = localSceneEditorLogic({ templateId: id })
  const {
    template,
    templateLoading,
    editorScenes,
    latestScenes,
    listing,
    selectedSceneId,
    panels,
    activePanel,
    previewScenes,
    unsavedChanges,
    saving,
    saveError,
    theme,
  } = useValues(logic)
  const { goBack, save, setListing, editorScenesChanged, togglePanel, showInPreview } = useActions(logic)
  const narrow = useSinglePanelMode()

  const width = template?.imageWidth || 800
  const height = template?.imageHeight || 480
  const actions: SceneEditorAction[] = [
    {
      Icon: Save,
      disabled: !template || saving || !unsavedChanges,
      emphasized: unsavedChanges,
      key: 'save',
      label: saving ? 'Saving…' : 'Save',
      onSelect: () => save(),
      primary: true,
      title: 'Save the scenes, name and description',
    },
  ]
  const shownSceneName = sceneNameFor(latestScenes ?? editorScenes, selectedSceneId)

  return (
    <div className={clsx('frameos-app-shell', `frameos-theme-${theme}`)}>
      <div
        className={clsx('frameos-scene-workspace editor-modal', `frameos-theme-${theme}`)}
        data-testid="local-scene-editor"
      >
        <SceneEditorBar actions={actions}>
          <SceneEditorBackButton label="Back" onClick={goBack} />
          <SceneEditorPanelToggles
            active={narrow ? singlePanelFor(panels, activePanel) : undefined}
            onToggle={(panel) => togglePanel(panel, narrow)}
            panels={panels}
          />
          <SceneNameTitle name={listing?.name ?? null} onRename={(name) => setListing({ name })} />
          {shownSceneName && shownSceneName !== listing?.name ? (
            <span className="editor-modal__frame-name">{shownSceneName}</span>
          ) : null}
          {saveError ? (
            <span className="pill pill-warning" role="alert">
              {saveError}
            </span>
          ) : unsavedChanges ? (
            <UnsavedPill label="Unsaved changes" short="Unsaved" />
          ) : null}
        </SceneEditorBar>
        {template && editorScenes ? (
          <SceneEditorWorkspace
            Editor={localTemplateEditorColumn(id)}
            scenes={editorScenes}
            sceneId={selectedSceneId}
            width={width}
            height={height}
            theme={theme}
            onScenesChanged={(scenes) => editorScenesChanged(scenes)}
            panels={shownPanels(panels, narrow, activePanel)}
            onClosePanel={(panel) => togglePanel(panel, narrow)}
            template={{
              name: listing?.name ?? template.name,
              description: listing?.description ?? null,
              category: null,
              tags: [],
              frameosVersion: null,
            }}
            onTemplateChanged={(changes) =>
              setListing({
                ...(typeof changes.name === 'string' ? { name: changes.name } : {}),
                ...(changes.description !== undefined ? { description: changes.description } : {}),
              })
            }
            // The template row keeps these two; the form edits them alone.
            templateFields={['name', 'description']}
            ai={{
              getScenes: () => localSceneEditorLogic({ templateId: id }).values.latestScenes,
              mode: 'existing',
              onScenes: (event) => applyAiEventToTemplate(id, event),
              onShowInPreview: ({ scenes, sceneId }) => showInPreview(scenes as SceneJson[], sceneId, narrow),
              settingsUrl: urls.settings(),
              framesUrl: urls.frames(),
              signedIn: true,
            }}
            preview={{ sceneId: null, scenes: previewScenes }}
          />
        ) : (
          <div className="editor-modal__frame editor-modal__frame--empty">
            {templateLoading ? (
              <div className="flex items-center gap-2 text-sm opacity-70">
                <Spinner className="h-4 w-4" />
                Loading the scene…
              </div>
            ) : (
              <div className="text-sm opacity-70">This saved scene could not be loaded.</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default LocalSceneEditor
