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
  const logicProps: EditAppLogicProps = {
    frameId,
    sceneId,
    nodeId,
    keyword: nodeData.keyword,
    sources: nodeData.sources,
  }
  const { sources, sourcesLoading, activeFile } = useValues(editAppLogic(logicProps))
  const { setActiveFile } = useActions(editAppLogic(logicProps))

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

  return (
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
          onChange={() => {}}
          options={{
            minimap: {
              enabled: false, // This line disables the minimap
            },
          }}
        />
      </div>
    </div>
  )
}
