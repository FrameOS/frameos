import { useActions, useValues } from 'kea'
import { editAppLogic, EditAppLogicProps } from './editAppLogic'
import { Button } from '../../../../components/Button'
import Editor from '@monaco-editor/react'
import { frameLogic } from '../../frameLogic'
import { frameEditorsLogic } from '../../frameEditorsLogic'
import { useEffect, useRef, useState } from 'react'
import schema from '../../../../../schema/config_json.json'
import type { editor as importedEditor } from 'monaco-editor'
import type { Monaco } from '@monaco-editor/react'
import clsx from 'clsx'
import { TrashIcon } from '@heroicons/react/24/solid'
import { DropdownMenu } from '../../../../components/DropdownMenu'
import { javascriptAppSourceFiles } from '../../../../utils/sceneApps'
import { workspaceLogic } from '../../../workspace/workspaceLogic'

interface EditAppProps {
  // When set, keeps editAppLogic mounted until the editor is closed via
  // frameEditorsLogic.closeEditor/closeSceneEditors
  editorKey?: string
  sceneId: string
  nodeId: string
  showFileList?: boolean
  compactWarnings?: boolean
  // Renders a slim Save / Discard row above the code editor. Hosts with their
  // own save controls (the apps workspace top bar) leave this off.
  showToolbar?: boolean
}

interface EditAppFileListProps {
  sceneId: string
  nodeId: string
  className?: string
}

export function appSourceEditorLanguage(file: string): string {
  return file.endsWith('.json')
    ? 'json'
    : file.endsWith('.ts') || file.endsWith('.tsx')
    ? 'typescript'
    : file.endsWith('.js') || file.endsWith('.jsx')
    ? 'javascript'
    : 'python'
}

/** Files the frame's module loader can `import`: the app's own code and JSON. */
export function isImportableAppSource(file: string): boolean {
  return /\.(ts|tsx|js|jsx|json)$/.test(file)
}

export function configureAppSourceEditor(monaco: Monaco) {
  const compilerOptions = {
    allowJs: true,
    allowNonTsExtensions: true,
    target: monaco.languages.typescript.ScriptTarget.ES2020,
    jsx: monaco.languages.typescript.JsxEmit.Preserve,
    // An app can `import { x } from './helper'` and `import data from
    // './data.json'` — the frame resolves both against the app's own files,
    // and so must the type checker here.
    module: monaco.languages.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    resolveJsonModule: true,
    allowSyntheticDefaultImports: true,
    esModuleInterop: true,
  }
  monaco.languages.typescript.typescriptDefaults.setCompilerOptions(compilerOptions)
  monaco.languages.typescript.javascriptDefaults.setCompilerOptions({ ...compilerOptions, checkJs: true })
  monaco.editor.defineTheme('darkframe', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: { 'editor.background': '#111827' },
  })
  monaco.editor.defineTheme('lightframe', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: { 'editor.background': '#f8fafc' },
  })
  monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
    validate: true,
    schemas: [
      {
        uri: 'http://internal/node-schema.json',
        fileMatch: ['config.json'],
        schema: schema,
      },
    ],
  })
}

// Where a built-in app's source lives in the FrameOS repository: every
// keyword is a directory under frameos/src/apps (e.g. data/chromiumScreenshot).
const SYSTEM_APP_SOURCE_URL = 'https://github.com/FrameOS/frameos/tree/main/frameos/src/apps/'

export function systemAppGithubUrl(keyword: string): string {
  return SYSTEM_APP_SOURCE_URL + keyword.split('/').map(encodeURIComponent).join('/')
}

/**
 * A compiled Nim app inside an interpreted scene is shown the way the system
 * apps page shows it: read only, with a link to the source. Editing it would
 * flip the whole scene to compiled mode (a full frame recompilation on every
 * later change), which is not something to stumble into from an editor tab.
 */
function ReadOnlyNimAppNotice({
  keyword,
  sceneLocal,
  converting,
  onConvert,
}: {
  keyword: string | null
  /** A Nim app the scene carries itself (legacy), as opposed to a built-in from the catalog. */
  sceneLocal: boolean
  converting: boolean
  onConvert: () => void
}): JSX.Element {
  if (sceneLocal) {
    return (
      <div className="app-compiled-warning flex flex-col gap-2 rounded-2xl p-3 text-sm @md:flex-row @md:items-center">
        <div className="min-w-0 flex-1">
          <span className="font-semibold">Legacy Nim app — convert the scene to interpreted.</span> This scene carries
          its own Nim app; running it needs a FrameOS source build on every deploy. The converter ports it to a
          JavaScript app.
        </div>
        <Button size="small" color="primary" disabled={converting} onClick={onConvert}>
          {converting ? 'Converting…' : 'Convert to an interpreted scene'}
        </Button>
      </div>
    )
  }
  return (
    <div className="frame-tool-card flex flex-col gap-2 rounded-2xl p-3 text-sm @md:flex-row @md:items-center">
      <div className="min-w-0 flex-1">
        <span className="font-semibold">Read only.</span> This is a built-in Nim app from the FrameOS catalog; edit it
        on GitHub. To customize it here, use a JavaScript app or an inline code node instead.
      </div>
      {keyword ? (
        <a
          href={systemAppGithubUrl(keyword)}
          target="_blank"
          rel="noreferrer"
          className="frameos-secondary-button inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-semibold"
        >
          Open in GitHub
        </a>
      ) : null}
    </div>
  )
}

export function EditAppFileList({ sceneId, nodeId, className }: EditAppFileListProps) {
  const { frameId } = useValues(frameLogic)
  const logicProps: EditAppLogicProps = {
    frameId,
    sceneId,
    nodeId,
  }
  const logic = editAppLogic(logicProps)
  const { filenames, sourcesLoading, activeFile, changedFiles, modelMarkers } = useValues(logic)
  const { setActiveFile, addFile, deleteFile } = useActions(logic)

  if (sourcesLoading) {
    return (
      <div className={clsx('app-file-list frameos-inset rounded-2xl border p-3', className)}>
        <div className="frameos-muted mb-2 text-xs font-semibold uppercase tracking-wide">Files</div>
        <div className="app-file-row flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-semibold">
          <span className="frameos-skeleton-media h-7 w-7 shrink-0 animate-pulse rounded-lg" />
          <span className="frameos-skeleton-line h-3 w-24 animate-pulse rounded-full" />
        </div>
      </div>
    )
  }

  return (
    <div className={clsx('app-file-list frameos-inset rounded-2xl border p-3', className)}>
      <div className="frameos-muted mb-2 text-xs font-semibold uppercase tracking-wide">Files</div>
      <div className="space-y-1">
        {filenames.map((file) => (
          <div key={file} className="flex w-full items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setActiveFile(file)}
              className={clsx(
                'app-file-row min-w-0 flex-1 truncate rounded-xl px-3 py-2 text-left text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
                activeFile === file
                  ? modelMarkers[file]?.length
                    ? 'app-file-row-error-active'
                    : 'app-file-row-active'
                  : modelMarkers[file]?.length
                  ? 'app-file-row-error'
                  : null
              )}
              title={
                modelMarkers[file]?.length
                  ? `line ${modelMarkers[file][0].startLineNumber}, col ${modelMarkers[file][0].startColumn}: ${modelMarkers[file][0].message}`
                  : file
              }
            >
              {changedFiles[file] ? '* ' : ''}
              {file}
            </button>
            {[...javascriptAppSourceFiles, 'app.nim', 'config.json'].includes(file) ? null : (
              <DropdownMenu
                buttonColor="none"
                horizontal
                className="app-file-action frameos-icon-button flex h-8 w-8 shrink-0 items-center justify-center rounded-lg !px-0 !py-0 shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                items={[
                  {
                    label: 'Delete file',
                    confirm: `Are you sure you want to delete ${file}?`,
                    onClick: () => deleteFile(file),
                    icon: <TrashIcon className="w-5 h-5" />,
                  },
                ]}
              />
            )}
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button color="none" size="small" onClick={() => addFile()} title="Add file">
          + Add file
        </Button>
      </div>
    </div>
  )
}

export function EditApp({
  editorKey,
  sceneId,
  nodeId,
  showFileList = true,
  compactWarnings = false,
  showToolbar = false,
}: EditAppProps) {
  const { frameId, convertingSceneId } = useValues(frameLogic)
  const { convertSceneToInterpreted } = useActions(frameLogic)
  const { theme } = useValues(workspaceLogic)
  const { persistUntilClosed } = useActions(frameEditorsLogic)
  const logicProps: EditAppLogicProps = {
    frameId,
    sceneId,
    nodeId,
  }
  const logic = editAppLogic(logicProps)
  const {
    sources,
    sourcesLoading,
    activeFile,
    modelMarkers,
    requiresCompiledOnSave,
    savedKeyword,
    sceneAppKey,
    appUsageCount,
    hasMultipleAppUsages,
    appTypeDeclarations,
    scene,
    hasChanges,
  } = useValues(logic)
  const { forkAndSaveChanges, updateFile, saveChanges, discardChanges } = useActions(logic)
  const [[monaco, editor], setMonacoAndEditor] = useState<[Monaco | null, importedEditor.IStandaloneCodeEditor | null]>(
    [null, null]
  )
  const appTypesLibsRef = useRef<{ dispose: () => void }[]>([])
  // Models for the app's other files, so `./helper` resolves while editing
  // app.ts. The Editor below adopts one of these when its tab is opened.
  const siblingModelsRef = useRef<Map<string, importedEditor.ITextModel>>(new Map())

  useEffect(() => {
    if (editorKey) {
      persistUntilClosed(editorKey, logic)
    }
  }, [editorKey])

  useEffect(() => {
    if (monaco && editor && activeFile) {
      const model = editor.getModel()
      if (model) {
        monaco.editor.setModelMarkers(model, 'owner', modelMarkers[activeFile] || [])
      }
    }
  }, [monaco, activeFile, modelMarkers])

  useEffect(() => {
    if (!monaco) {
      return
    }
    const present = new Set<string>()
    for (const [file, content] of Object.entries(sources)) {
      if (!isImportableAppSource(file)) {
        continue
      }
      present.add(file)
      const uri = monaco.Uri.parse(`inmemory://app-editor/${nodeId}/${file}`)
      const existing = monaco.editor.getModel(uri)
      if (!existing) {
        siblingModelsRef.current.set(file, monaco.editor.createModel(content ?? '', appSourceEditorLanguage(file), uri))
      } else if (file !== activeFile && existing.getValue() !== content) {
        existing.setValue(content ?? '')
      }
    }
    for (const [file, model] of siblingModelsRef.current) {
      if (!present.has(file) && file !== activeFile) {
        if (!model.isDisposed()) {
          model.dispose()
        }
        siblingModelsRef.current.delete(file)
      }
    }
  }, [monaco, sources, nodeId, activeFile])

  useEffect(() => {
    return () => {
      for (const model of siblingModelsRef.current.values()) {
        if (!model.isDisposed()) {
          model.dispose()
        }
      }
      siblingModelsRef.current.clear()
    }
  }, [nodeId])

  useEffect(() => {
    if (!monaco) {
      return
    }

    appTypesLibsRef.current.forEach((lib) => lib.dispose())
    appTypesLibsRef.current = [
      monaco.languages.typescript.typescriptDefaults.addExtraLib(
        appTypeDeclarations,
        `inmemory://app-editor/${nodeId}/frameos-app-typescript.d.ts`
      ),
      monaco.languages.typescript.javascriptDefaults.addExtraLib(
        appTypeDeclarations,
        `inmemory://app-editor/${nodeId}/frameos-app-javascript.d.ts`
      ),
    ]

    return () => {
      appTypesLibsRef.current.forEach((lib) => lib.dispose())
      appTypesLibsRef.current = []
    }
  }, [monaco, appTypeDeclarations, nodeId])

  if (sourcesLoading) {
    return <div>Loading...</div>
  }

  const editorLanguage = appSourceEditorLanguage(activeFile)

  return (
    <div className="flex flex-row gap-2 max-h-full h-full max-w-full w-full">
      {showFileList ? (
        <EditAppFileList
          sceneId={sceneId}
          nodeId={nodeId}
          className="h-full max-h-full w-auto max-w-60 overflow-x-auto"
        />
      ) : null}

      <div className="overflow-y-auto overflow-x-auto w-full h-full max-h-full max-w-full gap-2 flex-1 flex flex-col">
        {requiresCompiledOnSave && !compactWarnings ? (
          <ReadOnlyNimAppNotice
            keyword={savedKeyword}
            sceneLocal={Boolean(sceneAppKey)}
            converting={convertingSceneId === sceneId}
            onConvert={() => convertSceneToInterpreted(sceneId)}
          />
        ) : null}
        {hasMultipleAppUsages && !requiresCompiledOnSave ? (
          <div className="frame-tool-card flex flex-col gap-3 rounded-2xl p-3 text-sm @md:flex-row @md:items-center">
            <div className="min-w-0 font-medium">
              You are editing all {appUsageCount} uses of this app in this scene.
            </div>
            <Button size="small" color="secondary" onClick={forkAndSaveChanges} className="shrink-0">
              Fork and save this copy
            </Button>
          </div>
        ) : null}
        {showToolbar ? (
          <div className="edit-app-toolbar flex shrink-0 items-center gap-2 text-xs">
            <div className="frameos-muted min-w-0 flex-1 truncate font-mono" title={activeFile}>
              {activeFile}
              {hasChanges ? <span className="ml-1 font-sans font-semibold">(unsaved)</span> : null}
            </div>
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
        ) : null}
        <div className="frameos-inset overflow-hidden rounded-md border font-mono text-sm w-full flex-1">
          <Editor
            height="100%"
            path={`inmemory://app-editor/${nodeId}/${activeFile}`}
            language={editorLanguage}
            value={sources[activeFile] ?? sources[Object.keys(sources)[0]] ?? ''}
            theme={theme === 'dark' ? 'darkframe' : 'lightframe'}
            beforeMount={configureAppSourceEditor}
            onMount={(editor, monaco) => setMonacoAndEditor([monaco, editor])}
            onChange={(value) => updateFile(activeFile, value ?? '')}
            options={{
              minimap: { enabled: false },
              readOnly: requiresCompiledOnSave,
              domReadOnly: requiresCompiledOnSave,
            }}
          />
        </div>
      </div>
    </div>
  )
}
