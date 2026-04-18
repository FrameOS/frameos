import { useActions, useValues } from 'kea'
import { editAppLogic, EditAppLogicProps, JS_APP_HELP_TAB } from './editAppLogic'
import { Button } from '../../../../components/Button'
import Editor from '@monaco-editor/react'
import { PanelWithMetadata } from '../../../../types'
import { frameLogic } from '../../frameLogic'
import { panelsLogic } from '../panelsLogic'
import { chatLogic } from '../Chat/chatLogic'
import { useEffect, useRef, useState } from 'react'
import type { editor as importedEditor } from 'monaco-editor'
import type { Monaco } from '@monaco-editor/react'
import clsx from 'clsx'
import { TrashIcon } from '@heroicons/react/24/solid'
import { DropdownMenu } from '../../../../components/DropdownMenu'
import { Markdown } from '../../../../components/Markdown'

interface EditAppProps {
  panel: PanelWithMetadata
  sceneId: string
  nodeId: string
}

export function EditApp({ panel, sceneId, nodeId }: EditAppProps) {
  const { frameId } = useValues(frameLogic)
  const { persistUntilClosed, openChat } = useActions(panelsLogic)
  const { ensureChatForApp } = useActions(chatLogic({ frameId, sceneId }))
  const logicProps: EditAppLogicProps = {
    frameId,
    sceneId,
    nodeId,
  }
  const logic = editAppLogic(logicProps)
  const {
    isInterpreted,
    sources,
    filenames,
    sourcesLoading,
    activeFile,
    hasChanges,
    changedFiles,
    configJson,
    modelMarkers,
    savedKeyword,
    savedSources,
    isJsApp,
    jsAppReference,
    jsAppReferenceLoading,
    jsAppConfigJsonSchema,
    jsAppEditorDeclarations,
  } = useValues(logic)
  const { saveChanges, setActiveFile, updateFile, addFile, deleteFile, convertAppToTypeScript } = useActions(logic)
  const [[monaco, editor], setMonacoAndEditor] = useState<[Monaco | null, importedEditor.IStandaloneCodeEditor | null]>(
    [null, null]
  )
  const tsExtraLibRef = useRef<{ dispose: () => void } | null>(null)
  const jsExtraLibRef = useRef<{ dispose: () => void } | null>(null)
  const isHelpTab = activeFile === JS_APP_HELP_TAB
  const editorFile = !isJsApp && isHelpTab ? filenames[0] || 'config.json' : activeFile
  const showingHelp = isJsApp && isHelpTab

  useEffect(() => {
    persistUntilClosed(panel, logic)
  }, [])

  useEffect(() => {
    if (monaco && editor && editorFile && !showingHelp) {
      const model = editor.getModel()
      if (model) {
        monaco.editor.setModelMarkers(model, 'owner', modelMarkers[editorFile] || [])
      }
    }
  }, [monaco, editorFile, showingHelp, modelMarkers])

  useEffect(() => {
    if (!monaco) {
      return
    }

    monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
      validate: true,
      schemas: [
        {
          uri: 'http://internal/node-schema.json',
          fileMatch: ['config.json'],
          schema: jsAppConfigJsonSchema,
        },
      ],
    })
  }, [monaco, jsAppConfigJsonSchema])

  useEffect(() => {
    if (!monaco) {
      return
    }

    tsExtraLibRef.current?.dispose()
    jsExtraLibRef.current?.dispose()
    tsExtraLibRef.current = null
    jsExtraLibRef.current = null

    if (!isJsApp) {
      return
    }

    const uri = `inmemory://edit-app/${sceneId}/${nodeId}/frameos-app-globals.d.ts`
    const nextTsLib = monaco.languages.typescript.typescriptDefaults.addExtraLib(jsAppEditorDeclarations, uri)
    const nextJsLib = monaco.languages.typescript.javascriptDefaults.addExtraLib(jsAppEditorDeclarations, uri)
    tsExtraLibRef.current = nextTsLib
    jsExtraLibRef.current = nextJsLib

    return () => {
      nextTsLib.dispose()
      nextJsLib.dispose()
      if (tsExtraLibRef.current === nextTsLib) {
        tsExtraLibRef.current = null
      }
      if (jsExtraLibRef.current === nextJsLib) {
        jsExtraLibRef.current = null
      }
    }
  }, [isJsApp, jsAppEditorDeclarations, monaco, nodeId, sceneId])

  function beforeMount(monaco: Monaco) {
    monaco.editor.defineTheme('darkframe', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: { 'editor.background': '#000000' },
    })
    monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
      allowNonTsExtensions: true,
      module: monaco.languages.typescript.ModuleKind.ESNext,
      moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
      noEmit: true,
      strict: true,
      target: monaco.languages.typescript.ScriptTarget.ES2020,
    })
    monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
      allowJs: true,
      allowNonTsExtensions: true,
      checkJs: true,
      module: monaco.languages.typescript.ModuleKind.ESNext,
      moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
      noEmit: true,
      target: monaco.languages.typescript.ScriptTarget.ES2020,
    })
    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: false,
      noSyntaxValidation: false,
    })
    monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: false,
      noSyntaxValidation: false,
    })
  }

  if (sourcesLoading) {
    return <div>Loading...</div>
  }

  const name = configJson?.name || savedKeyword || nodeId
  const editorLanguage = editorFile.endsWith('.json')
    ? 'json'
    : editorFile.endsWith('.ts')
    ? 'typescript'
    : editorFile.endsWith('.js')
    ? 'javascript'
    : 'python'

  return (
    <div className="flex flex-row gap-2 max-h-full h-full max-w-full w-full">
      <div className="w-auto max-w-60 max-h-full h-full overflow-x-auto space-y-1">
        {filenames.map((file) => (
          <div key={file} className="w-full flex justify-between gap-2">
            <Button
              size="small"
              color={activeFile === file ? (modelMarkers[file]?.length ? 'red' : 'primary') : 'none'}
              onClick={() => setActiveFile(file)}
              className={clsx(
                'whitespace-nowrap',
                modelMarkers[file]?.length ? (activeFile === file ? 'text-red-200' : 'text-red-500') : ''
              )}
              title={
                modelMarkers[file]?.length
                  ? `line ${modelMarkers[file][0].startLineNumber}, col ${modelMarkers[file][0].startColumn}: ${modelMarkers[file][0].message}`
                  : undefined
              }
            >
              {changedFiles[file] ? '* ' : ''}
              {file}
            </Button>
            {['app.ts', 'app.js', 'app.nim', 'config.json'].includes(file) ? null : (
              <DropdownMenu
                buttonColor="none"
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
        <div>
          <Button color="none" size="small" onClick={() => addFile()} title="Add file">
            + Add file
          </Button>
        </div>

        {isJsApp ? (
          <div>
            <Button color={showingHelp ? 'primary' : 'none'} size="small" onClick={() => setActiveFile(JS_APP_HELP_TAB)}>
              Help
            </Button>
          </div>
        ) : null}

        {isJsApp && sources['app.js'] && !sources['app.ts'] ? (
          <div>
            <Button color="none" size="small" onClick={convertAppToTypeScript}>
              Convert to TypeScript
            </Button>
          </div>
        ) : null}

        <div>
          <Button
            color="none"
            size="small"
            onClick={() => {
              openChat()
              ensureChatForApp(sceneId, nodeId)
            }}
          >
            💬 Chat about this app
          </Button>
        </div>
      </div>

      <div className="overflow-y-auto overflow-x-auto w-full h-full max-h-full max-w-full gap-2 flex-1 flex flex-col">
        {hasChanges ? (
          <div className="bg-gray-900 p-2">
            {isInterpreted && isJsApp ? (
              <>
                Saving changes will fork this app into the scene. Interpreted deploys will use this forked version for
                this node and for any edited-app copies you add from the panel.
                <Button size="small" onClick={saveChanges}>
                  {savedSources ? 'Save forked app changes' : 'Fork this app into the scene'}
                </Button>
              </>
            ) : isInterpreted ? (
              <>
                You have made changes to this app. If you save them, we will have to change the scene's execution model
                from "interpreted" to "compiled". Thereafter, any changes to the scene will require a full frame
                recompilation. If you have used any inline code nodes, you will also have to rewrite them from
                JavaScript to Nim.
                <Button size="small" onClick={saveChanges}>
                  I understand. Save the changes
                </Button>
              </>
            ) : (
              <>
                You have changes.{' '}
                <Button size="small" onClick={saveChanges}>
                  Click here to {!savedSources ? 'fork the app' : 'save them'}
                </Button>
              </>
            )}
          </div>
        ) : null}
        <div className="bg-black font-mono text-sm overflow-y-auto overflow-x-auto w-full flex-1">
          {showingHelp ? (
            <div className="p-4 text-sm text-gray-200 overflow-y-auto h-full">
              {jsAppReferenceLoading ? (
                <div>Loading help...</div>
              ) : jsAppReference ? (
                <Markdown value={jsAppReference} />
              ) : (
                <div>Unable to load JS app help.</div>
              )}
            </div>
          ) : (
            <Editor
              height="100%"
              path={`${nodeId}/${editorFile}`}
              language={editorLanguage}
              value={sources[editorFile] ?? sources[Object.keys(sources)[0]] ?? ''}
              theme="darkframe"
              beforeMount={beforeMount}
              onMount={(editor, monaco) => setMonacoAndEditor([monaco, editor])}
              onChange={(value) => updateFile(editorFile, value ?? '')}
              options={{ minimap: { enabled: false } }}
            />
          )}
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
