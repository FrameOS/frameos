import { useActions, useValues } from 'kea'
import { editAppLogic } from './editAppLogic'
import { Button } from '../../../../components/Button'
import Editor from '@monaco-editor/react'

interface EditAppProps {
  keyword: string
}

export function EditApp({ keyword }: EditAppProps) {
  const { sources, sourcesLoading, activeFile } = useValues(editAppLogic({ keyword }))
  const { setActiveFile } = useActions(editAppLogic({ keyword }))

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
          path={`${keyword}/${activeFile}`}
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
