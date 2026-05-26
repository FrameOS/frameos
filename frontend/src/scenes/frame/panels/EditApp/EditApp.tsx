import { useActions, useValues } from 'kea'
import { editAppLogic, EditAppLogicProps } from './editAppLogic'
import { Button } from '../../../../components/Button'
import Editor from '@monaco-editor/react'
import { PanelWithMetadata } from '../../../../types'
import { frameLogic } from '../../frameLogic'
import { panelsLogic } from '../panelsLogic'
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
  panel?: PanelWithMetadata
  sceneId: string
  nodeId: string
  showFileList?: boolean
  compactWarnings?: boolean
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

export function configureAppSourceEditor(monaco: Monaco) {
  const compilerOptions = {
    allowJs: true,
    allowNonTsExtensions: true,
    target: monaco.languages.typescript.ScriptTarget.ES2020,
    jsx: monaco.languages.typescript.JsxEmit.Preserve,
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

function CompiledAppWarning({ sceneName, compact }: { sceneName: string; compact?: boolean }): JSX.Element {
  const body = (
    <div>
      This is a compiled Nim app, but the scene &quot;{sceneName}&quot; is currently running in interpreted mode. If you
      edit and save it, the scene will switch to compiled mode. After that, future scene changes will require a full
      frame recompilation. Inline JavaScript code nodes would also need to be rewritten in Nim. If you need
      customization without compilation, consider using JavaScript apps or inline JavaScript code nodes instead.
    </div>
  )

  if (compact) {
    return (
      <details className="app-compiled-warning app-compiled-warning-collapsible rounded-2xl p-3 text-sm">
        <summary className="cursor-pointer font-semibold">Compiled Nim app in an interpreted scene</summary>
        <div className="mt-3">{body}</div>
      </details>
    )
  }

  return (
    <div className="app-compiled-warning rounded-2xl p-3 text-sm">
      <div className="space-y-3">
        <div className="font-semibold">Compiled Nim app in an interpreted scene</div>
        {body}
      </div>
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

export function EditApp({ panel, sceneId, nodeId, showFileList = true, compactWarnings = false }: EditAppProps) {
  const { frameId } = useValues(frameLogic)
  const { theme } = useValues(workspaceLogic)
  const { persistUntilClosed } = useActions(panelsLogic)
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
    appUsageCount,
    hasMultipleAppUsages,
    appTypeDeclarations,
    scene,
  } = useValues(logic)
  const { forkAndSaveChanges, updateFile } = useActions(logic)
  const [[monaco, editor], setMonacoAndEditor] = useState<[Monaco | null, importedEditor.IStandaloneCodeEditor | null]>(
    [null, null]
  )
  const appTypesLibsRef = useRef<{ dispose: () => void }[]>([])

  useEffect(() => {
    if (panel) {
      persistUntilClosed(panel, logic)
    }
  }, [panel])

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
  const sceneName = scene?.name || 'Untitled scene'

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
        {requiresCompiledOnSave ? <CompiledAppWarning sceneName={sceneName} compact={compactWarnings} /> : null}
        {hasMultipleAppUsages ? (
          <div className="frame-tool-card flex flex-col gap-3 rounded-2xl p-3 text-sm @md:flex-row @md:items-center">
            <div className="min-w-0 font-medium">
              You are editing all {appUsageCount} uses of this app in this scene.
            </div>
            <Button size="small" color="secondary" onClick={forkAndSaveChanges} className="shrink-0">
              Fork and save this copy
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
            options={{ minimap: { enabled: false } }}
          />
        </div>
      </div>
    </div>
  )
}
EditApp.PanelTitle = function EditAppPanelTitle({ panel, sceneId, nodeId }: EditAppProps) {
  const { frameId } = useValues(frameLogic)
  const logicProps: EditAppLogicProps = {
    frameId,
    sceneId,
    nodeId,
  }
  const { hasChanges, configJson, savedKeyword, title } = useValues(editAppLogic(logicProps))

  return (
    <div title={nodeId}>
      {hasChanges ? '* ' : ''}
      {title}
    </div>
  )
}
