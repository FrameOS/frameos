import { useActions, useValues } from 'kea'
import { editAppLogic } from './editAppLogic'
import { Button } from '../../../../components/Button'

interface EditAppProps {
  keyword: string
}

export function EditApp({ keyword }: EditAppProps) {
  const { sources, sourcesLoading, activeFile } = useValues(editAppLogic({ keyword }))
  const { setActiveFile } = useActions(editAppLogic({ keyword }))
  return (
    <div className="space-y-2">
      <div className="font-bold">Built-in apps are view-only. Forking and editing of custom apps coming soon.</div>
      <div className="flex flex-row">
        <div>
          {Object.entries(sources).map(([file, source]) => (
            <div key={file} className="w-min">
              <Button size="small" color="none" onClick={() => setActiveFile(file)}>
                {file}
              </Button>
            </div>
          ))}
        </div>
        <div>
          <div className="bg-black p-4 font-mono text-sm overflow-y-scroll overflow-x-hidden w-max">
            <pre>{sources[activeFile] ?? sources[Object.keys(sources)[0]] ?? ''}</pre>
          </div>
        </div>
      </div>
    </div>
  )
}
