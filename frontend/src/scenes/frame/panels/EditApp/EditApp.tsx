import { useActions, useValues } from 'kea'
import { editAppLogic, EditAppLogicProps } from './editAppLogic'
import { Button } from '../../../../components/Button'
import Editor from '@monaco-editor/react'
import { AppNodeData, PanelWithMetadata } from '../../../../types'
import { frameLogic } from '../../frameLogic'
import { panelsLogic } from '../panelsLogic'
import React, { useEffect, useState } from 'react'
import schema from '../../../../../schema/config_json.json'
import type { editor as importedEditor } from 'monaco-editor'
import type { Monaco } from '@monaco-editor/react'
import clsx from 'clsx'
import { BeakerIcon, TrashIcon } from '@heroicons/react/24/solid'
import { Spinner } from '../../../../components/Spinner'
import { TextArea } from '../../../../components/TextArea'
import { Markdown } from '../../../../components/Markdown'
import { DropdownMenu } from '../../../../components/DropdownMenu'

interface EditAppProps {
  panel: PanelWithMetadata
  sceneId: string
  nodeId: string
}

export function EditApp({ panel, sceneId, nodeId }: EditAppProps) {
  const { frameId } = useValues(frameLogic)
  const { persistUntilClosed } = useActions(panelsLogic)
  const logicProps: EditAppLogicProps = {
    frameId,
    sceneId,
    nodeId,
  }
  const logic = editAppLogic(logicProps)
  const {
    sources,
    filenames,
    sourcesLoading,
    activeFile,
    hasChanges,
    changedFiles,
    configJson,
    modelMarkers,
    enhanceSuggestion,
    enhanceSuggestionLoading,
    prompt,
    savedKeyword,
    savedSources,
    title,
  } = useValues(logic)
  const { saveChanges, setActiveFile, updateFile, enhance, addFile, deleteFile, setPrompt } = useActions(logic)
  const [[monaco, editor], setMonacoAndEditor] = useState<[Monaco | null, importedEditor.IStandaloneCodeEditor | null]>(
    [null, null]
  )

  useEffect(() => {
    persistUntilClosed(panel, logic)
  }, [])

  useEffect(() => {
    if (monaco && editor && activeFile) {
      const model = editor.getModel()
      if (model) {
        monaco.editor.setModelMarkers(model, 'owner', modelMarkers[activeFile] || [])
      }
    }
  }, [monaco, activeFile, modelMarkers])

  function beforeMount(monaco: Monaco) {
    monaco.editor.defineTheme('darkframe', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: { 'editor.background': '#000000' },
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

  const name = configJson?.name || savedKeyword || nodeId

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
            {file === 'app.nim' ? (
              <Button
                color={activeFile === 'app.nim/suggestion' ? 'primary' : 'gray'}
                size="small"
                title={'Talk to ChatGPT'}
                onClick={() => setActiveFile('app.nim/suggestion')}
              >
                {enhanceSuggestionLoading ? <Spinner color="white" /> : <BeakerIcon className="w-5 h-5" />}
              </Button>
            ) : file === 'config.json' ? null : (
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
      </div>

      <div className="overflow-y-auto overflow-x-auto w-full h-full max-h-full max-w-full gap-2 flex-1 flex flex-col">
        {!savedSources && !hasChanges ? (
          <div className="bg-gray-950 p-2">
            You're editing a read-only system app <strong>{name}</strong>. Changes will be saved on a copy on the scene.
          </div>
        ) : hasChanges ? (
          <div className="bg-gray-900 p-2">
            You have changes.{' '}
            <Button size="small" onClick={saveChanges}>
              Click here to {!savedSources ? 'fork the app' : 'save them'}
            </Button>
          </div>
        ) : null}
        {activeFile === 'app.nim/suggestion' ? (
          <div className="p-4 bg-gray-700 text-md overflow-y-auto overflow-x-auto w-full space-y-4">
            <p>
              Ask a question about <code>app.nim</code> from GPT-4. Keep an eye on your{' '}
              <a
                href="https://platform.openai.com/account/usage"
                className="text-blue-400 hover:underline"
                rel="noreferrer noopener"
              >
                billing
              </a>
              !
            </p>
            <TextArea value={prompt} onChange={setPrompt} rows={3} />
            <Button onClick={enhanceSuggestionLoading ? () => {} : enhance}>
              {enhanceSuggestionLoading ? <Spinner color="white" /> : 'Ask'}
            </Button>
            <Markdown value={enhanceSuggestion ?? ''} />
          </div>
        ) : (
          <div className="bg-black font-mono text-sm overflow-y-auto overflow-x-auto w-full flex-1">
            <Editor
              height="100%"
              path={`${nodeId}/${activeFile}`}
              language={activeFile.endsWith('.json') ? 'json' : 'python'}
              value={sources[activeFile] ?? sources[Object.keys(sources)[0]] ?? ''}
              theme="darkframe"
              beforeMount={beforeMount}
              onMount={(editor, monaco) => setMonacoAndEditor([monaco, editor])}
              onChange={(value) => updateFile(activeFile, value ?? '')}
              options={{ minimap: { enabled: false } }}
            />
          </div>
        )}
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
