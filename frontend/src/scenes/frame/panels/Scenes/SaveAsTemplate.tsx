import { useActions, useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { Button } from '../../../../components/Button'
import { templatesLogic } from './templatesLogic'
import { EditTemplate } from './EditTemplate'
import { ArrowDownTrayIcon, DocumentPlusIcon } from '@heroicons/react/24/outline'

interface TemplatesProps extends React.HTMLAttributes<HTMLDivElement> {
  className?: string
}

export function SaveAsTemplate(props: TemplatesProps) {
  const { frameId } = useValues(frameLogic)
  const { saveAsNewTemplate } = useActions(templatesLogic({ frameId }))

  return (
    <div {...props}>
      <Button size="small" color="secondary" className="flex gap-1 items-center" onClick={saveAsNewTemplate}>
        <DocumentPlusIcon className="w-4 h-4" />
        Save current scenes as local template
      </Button>
      <EditTemplate />
    </div>
  )
}
