import { useActions, useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { Button } from '../../../../components/Button'
import { templatesLogic } from './templatesLogic'
import { CloudArrowDownIcon } from '@heroicons/react/24/outline'

interface TemplatesProps extends React.HTMLAttributes<HTMLDivElement> {
  className?: string
}

export function SaveAsZip(props: TemplatesProps) {
  const { frameId, frameForm } = useValues(frameLogic)
  const { saveAsZip } = useActions(templatesLogic({ frameId }))

  return (
    <div {...props}>
      <Button
        size="small"
        color="secondary"
        className="flex gap-1 items-center"
        onClick={() => saveAsZip({ name: frameForm.name || 'Exported scenes' })}
      >
        <CloudArrowDownIcon className="w-4 h-4" />
        Download as .zip
      </Button>
    </div>
  )
}
