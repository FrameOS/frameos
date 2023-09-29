import { useActions, useValues } from 'kea'
import { editAppLogic } from './editAppLogic'
import { Button } from '../../../../components/Button'

interface EditAppProps {
  keyword: string
}

export function EditApp({ keyword }: EditAppProps) {
  const { sources, sourcesLoading, activeFile } = useValues(editAppLogic({ keyword }))
  const { setActiveFile } = useActions(editAppLogic({ keyword }))
  if (sourcesLoading) {
    return <div>Loading...</div>
  }
  return (
    <div className="flex flex-row max-h-full h-full max-w-full w-full">
      <div className="max-w-40">
        {Object.entries(sources).map(([file, source]) => (
          <div key={file} className="w-min">
            <Button size="small" color={activeFile === file ? 'teal' : 'none'} onClick={() => setActiveFile(file)}>
              {file}
            </Button>
          </div>
        ))}
      </div>
      <div className="bg-black p-4 font-mono text-sm overflow-y-auto overflow-x-auto w-full">
        <pre>{sources[activeFile] ?? sources[Object.keys(sources)[0]] ?? ''}</pre>
      </div>
    </div>
  )
}
