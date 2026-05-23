import { useActions, useValues } from 'kea'
import { editAppLogic, EditAppLogicProps } from './editAppLogic'
import { Button } from '../../../../components/Button'
import Editor from '@monaco-editor/react'
import { PanelWithMetadata } from '../../../../types'
import { frameLogic } from '../../frameLogic'
import { panelsLogic } from '../panelsLogic'
import { chatLogic } from '../Chat/chatLogic'
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
  onOpenChat?: () => void
  showFileList?: boolean
}

interface EditAppFileListProps {
  sceneId: string
  nodeId: string
  onOpenChat?: () => void
  className?: string
}

export function EditAppFileList({ sceneId, nodeId, onOpenChat, className }: EditAppFileListProps) {
  const { frameId } = useValues(frameLogic)
  const { openChat } = useActions(panelsLogic)
  const { ensureChatForApp } = useActions(chatLogic({ frameId, sceneId }))
  const logicProps: EditAppLogicProps = {
    frameId,
    sceneId,
    nodeId,
  }
  const logic = editAppLogic(logicProps)
  const { filenames, sourcesLoading, activeFile, changedFiles, modelMarkers } = useValues(logic)
  const { setActiveFile, addFile, deleteFile } = useActions(logic)

  if (sourcesLoading) {
    return <div className="frameos-muted rounded-2xl bg-white/55 p-3 text-sm text-slate-400">Loading files...</div>
  }

  return (
    <div className={clsx('frameos-inset rounded-2xl border border-slate-200 bg-white/55 p-3', className)}>
      <div className="frameos-muted mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Files</div>
      <div className="space-y-1">
        {filenames.map((file) => (
          <div key={file} className="flex w-full items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setActiveFile(file)}
              className={clsx(
                'min-w-0 flex-1 truncate rounded-xl px-3 py-2 text-left text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
                  activeFile === file
                    ? modelMarkers[file]?.length
                      ? 'bg-red-500 text-white'
                      : 'frameos-primary-active'
                  : modelMarkers[file]?.length
                  ? 'text-red-500 hover:bg-red-50'
                  : 'frameos-strong text-slate-700 hover:bg-white'
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
                className="frameos-icon-button flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/70 !px-0 !py-0 text-slate-500 shadow-sm transition hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
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
        <Button
          color="none"
          size="small"
          onClick={() => {
            ensureChatForApp(sceneId, nodeId)
            if (onOpenChat) {
              onOpenChat()
            } else {
              openChat()
            }
          }}
        >
          Chat about this app
        </Button>
      </div>
    </div>
  )
}

export function EditApp({ panel, sceneId, nodeId, onOpenChat, showFileList = true }: EditAppProps) {
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
    hasChanges,
    modelMarkers,
    requiresCompiledOnSave,
    appUsageCount,
    hasMultipleAppUsages,
    appTypeDeclarations,
  } = useValues(logic)
  const { saveChanges, forkAndSaveChanges, updateFile } = useActions(logic)
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

  function beforeMount(monaco: Monaco) {
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
          fileMatch: ['config.json'], // associate with our model
          schema: schema,
        },
      ],
    })
  }

  if (sourcesLoading) {
    return <div>Loading...</div>
  }

  const editorLanguage = activeFile.endsWith('.json')
    ? 'json'
    : activeFile.endsWith('.ts') || activeFile.endsWith('.tsx')
    ? 'typescript'
    : activeFile.endsWith('.js') || activeFile.endsWith('.jsx')
    ? 'javascript'
    : 'python'

  return (
    <div className="flex flex-row gap-2 max-h-full h-full max-w-full w-full">
      {showFileList ? (
        <EditAppFileList
          sceneId={sceneId}
          nodeId={nodeId}
          onOpenChat={onOpenChat}
          className="h-full max-h-full w-auto max-w-60 overflow-x-auto"
        />
      ) : null}

      <div className="overflow-y-auto overflow-x-auto w-full h-full max-h-full max-w-full gap-2 flex-1 flex flex-col">
        {hasChanges ? (
          <div className="frame-tool-card rounded-2xl p-3">
            {requiresCompiledOnSave ? (
              <>
                You have made changes to this app. If you save them, we will have to change the scene's execution model
                from "interpreted" to "compiled". Thereafter, any changes to the scene will require a full frame
                recompilation. If you have used any inline code nodes, you will also have to rewrite them from
                JavaScript to Nim.
                <Button size="small" onClick={saveChanges}>
                  I understand. Save the changes
                </Button>
              </>
            ) : hasMultipleAppUsages ? (
              <div className="space-y-2">
                <div>You are editing all {appUsageCount} uses of this app in this scene.</div>
                <div className="flex flex-wrap gap-2">
                  <Button size="small" onClick={saveChanges}>
                    Save for all usages
                  </Button>
                  <Button size="small" color="secondary" onClick={forkAndSaveChanges}>
                    Fork and save this copy
                  </Button>
                </div>
              </div>
            ) : (
              <>
                You have changes.{' '}
                <Button size="small" onClick={saveChanges}>
                  Save changes
                </Button>
              </>
            )}
          </div>
        ) : null}
        <div className="frameos-inset overflow-hidden rounded-2xl border font-mono text-sm w-full flex-1">
          <Editor
            height="100%"
            path={`inmemory://app-editor/${nodeId}/${activeFile}`}
            language={editorLanguage}
            value={sources[activeFile] ?? sources[Object.keys(sources)[0]] ?? ''}
            theme={theme === 'dark' ? 'darkframe' : 'lightframe'}
            beforeMount={beforeMount}
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
