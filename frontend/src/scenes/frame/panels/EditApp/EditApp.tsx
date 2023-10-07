import { useActions, useValues } from 'kea'
import { editAppLogic, EditAppLogicProps } from './editAppLogic'
import { Button } from '../../../../components/Button'
import Editor from '@monaco-editor/react'
import { AppNodeData } from '../../../../types'
import { frameLogic } from '../../frameLogic'

interface EditAppProps {
  sceneId: string
  nodeId: string
  nodeData: AppNodeData
}

export function EditApp({ sceneId, nodeId, nodeData }: EditAppProps) {
  const { id: frameId } = useValues(frameLogic)
  const { updateNodeSource } = useActions(frameLogic)
  const logicProps: EditAppLogicProps = {
    frameId,
    sceneId,
    nodeId,
    keyword: nodeData.keyword,
    sources: nodeData.sources,
    onChange: (file, source) => {
      updateNodeSource(sceneId, nodeId, file, source)
      // TODO: this does nothing
    },
  }
  const { sources, sourcesLoading, activeFile, hasChanges, configJson } = useValues(editAppLogic(logicProps))
  const { setActiveFile, updateFile } = useActions(editAppLogic(logicProps))

  function setEditorTheme(monaco: any) {
    monaco.editor.defineTheme('darkframe', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: { 'editor.background': '#000000' },
    })
  }

  if (sourcesLoading) {
    return <div>Loading...</div>
  }

  const name = configJson?.name || nodeData.keyword

  return (
    <div className="flex flex-col gap-2 max-h-full h-full max-w-full w-full">
      <div className="bg-gray-700 p-2 border-gray-500">
        {nodeData.keyword ? (
          hasChanges ? (
            <>
              <strong>{name}</strong> will be forked onto the current scene when you save
            </>
          ) : (
            <>
              <strong>Note!</strong> You're editing the system app <strong>{name}</strong>. If you make any changes, the
              app will be forked onto the current scene.
            </>
          )
        ) : null}
      </div>
      <div className="flex flex-row gap-2 max-h-full h-full max-w-full w-full">
        <div className="max-w-40 space-y-1">
          {Object.entries(sources).map(([file, source]) => (
            <div key={file} className="w-min">
              <Button size="small" color={activeFile === file ? 'teal' : 'none'} onClick={() => setActiveFile(file)}>
                {file}
              </Button>
            </div>
          ))}
        </div>
        <div className="bg-black font-mono text-sm overflow-y-auto overflow-x-auto w-full">
          <Editor
            height="100%"
            path={`${nodeId}/${activeFile}`}
            language={activeFile.endsWith('.json') ? 'json' : 'python'}
            value={sources[activeFile] ?? sources[Object.keys(sources)[0]] ?? ''}
            theme="darkframe"
            beforeMount={setEditorTheme}
            onChange={(value) => updateFile(activeFile, value ?? '')}
            options={{ minimap: { enabled: false } }}
          />
        </div>
      </div>
    </div>
  )
}
