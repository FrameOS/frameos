import { useActions, useValues } from 'kea'
import { editAppLogic } from './editAppLogic'
import { Button } from '../../../../components/Button'

interface EditAppProps {
  keyword: string
}

export function EditApp({ keyword }: EditAppProps) {
  const { sources, sourcesLoading, openFiles } = useValues(editAppLogic({ keyword }))
  const { toggleFile } = useActions(editAppLogic({ keyword }))
  return (
    <div className="space-y-2">
      <div className="font-bold">Built-in apps are view-only. Forking and editing of custom apps coming soon.</div>
      {sourcesLoading
        ? '...'
        : Object.entries(sources).map(([file, source]) => {
            return (
              <div key={file}>
                <div className="w-min">
                  <Button size="small" onClick={() => toggleFile(file)}>
                    {file}
                  </Button>
                </div>
                {openFiles.includes(file) && (
                  <div className="bg-black p-4 font-mono text-sm overflow-y-scroll overflow-x-hidden">
                    <pre>{source}</pre>
                  </div>
                )}
              </div>
            )
          })}
    </div>
  )
}
