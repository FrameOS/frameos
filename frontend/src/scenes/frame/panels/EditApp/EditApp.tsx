import { useActions, useValues } from 'kea'
import { editAppLogic, EditAppLogicProps } from './editAppLogic'
import { Button } from '../../../../components/Button'
import Editor from '@monaco-editor/react'
import { PanelWithMetadata } from '../../../../types'
import { frameLogic } from '../../frameLogic'
import { panelsLogic } from '../panelsLogic'
import { useEffect, useState } from 'react'
import schema from '../../../../../schema/config_json.json'
import type { editor as importedEditor } from 'monaco-editor'
import type { Monaco } from '@monaco-editor/react'
import clsx from 'clsx'
import { TrashIcon } from '@heroicons/react/24/solid'
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
  } = useValues(logic)
  const { saveChanges, setActiveFile, updateFile, addFile, deleteFile } = useActions(logic)
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
            {file === 'app.nim' || file === 'config.json' ? null : (
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
        {hasChanges ? (
          <div className="bg-gray-900 p-2">
            {isInterpreted ? (
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
