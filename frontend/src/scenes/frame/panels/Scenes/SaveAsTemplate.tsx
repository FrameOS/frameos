import { useActions, useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { Button } from '../../../../components/Button'
import { templatesLogic } from './templatesLogic'
import { EditTemplate } from './EditTemplate'
import { FolderArrowDownIcon } from '@heroicons/react/24/outline'

interface TemplatesProps extends React.HTMLAttributes<HTMLDivElement> {
  className?: string
}

export function SaveAsTemplate(props: TemplatesProps) {
  const { frameId } = useValues(frameLogic)
  const { saveAsNewTemplate } = useActions(templatesLogic({ frameId }))

  return (
    <div {...props}>
      <Button size="small" color="secondary" className="flex gap-1 items-center" onClick={saveAsNewTemplate}>
        <FolderArrowDownIcon className="w-4 h-4" />
        Export scenes as a local template
      </Button>
      <EditTemplate />
    </div>
  )
}
