import { TemplateType } from '../../../../types'
import { H6 } from '../../../../components/H6'

import { ArrowDownTrayIcon, PencilSquareIcon, TrashIcon } from '@heroicons/react/24/solid'
import { DropdownMenu } from '../../../../components/DropdownMenu'
import { DocumentArrowDownIcon, CloudArrowDownIcon, DocumentPlusIcon, DocumentIcon } from '@heroicons/react/24/outline'

interface TemplateProps {
  template: TemplateType
  applyTemplate: (template: TemplateType, wipe?: boolean) => void
  exportTemplate?: (id: string, format?: string) => void
  removeTemplate?: (id: string) => void
  editTemplate?: (template: TemplateType) => void
}
export function Template({ template, exportTemplate, removeTemplate, applyTemplate, editTemplate }: TemplateProps) {
  return (
    <div
      className="shadow bg-gray-900 break-inside-avoid dndnode relative rounded-lg"
      style={
        template.image_width && template.image_height
          ? {
              backgroundImage: `url("${template.image}")`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
              // aspectRatio: `${template.image_width} / ${template.image_height}`,
            }
          : {}
      }
    >
      <div
        className="w-full h-full p-3 space-y-2 rounded-lg border border-gray-700"
        style={{
          backgroundImage:
            'linear-gradient(to bottom, rgba(0, 0, 0, 0.8) 0%, rgba(0, 0, 0, 0.6) 30%, rgba(0, 0, 0, 0.7) 70%, rgba(0, 0, 0, 0.8) 100%)',
        }}
      >
        <div className="flex items-start justify-between">
          <H6>{template.name}</H6>
          <div className="flex items-start gap-1">
            <DropdownMenu
              buttonColor="secondary"
              items={[
                ...(!template.id
                  ? [
                      {
                        label: 'Save locally',
                        confirm: 'This will add this template to the list of local templates. You can then install it',
                        onClick: () => applyTemplate(template),
                        icon: <ArrowDownTrayIcon className="w-5 h-5" />,
                      },
                    ]
                  : []),
                ...(template.id
                  ? [
                      {
                        label: `Add to frame (+${(template.scenes || []).length} scene${
                          (template.scenes || []).length === 1 ? '' : 's'
                        })`,
                        onClick: () => applyTemplate(template),
                        icon: <DocumentPlusIcon className="w-5 h-5" />,
                      },
                      {
                        label: `Replace existing scenes`,
                        confirm: 'Are you sure? This will erase all scenes from the frame and install this template.',
                        onClick: () => applyTemplate(template, true),
                        icon: <DocumentIcon className="w-5 h-5" />,
                      },
                    ]
                  : []),
                ...(exportTemplate
                  ? [
                      {
                        label: 'Download .zip',
                        onClick: () => (template.id ? exportTemplate(template.id, 'zip') : null),
                        icon: <CloudArrowDownIcon className="w-5 h-5" />,
                      },
                    ]
                  : []),
                ...(editTemplate
                  ? [
                      {
                        label: 'Edit metadata',
                        onClick: () => editTemplate(template),
                        icon: <PencilSquareIcon className="w-5 h-5" />,
                      },
                    ]
                  : []),
                ...(removeTemplate
                  ? [
                      {
                        label: 'Delete',
                        confirm: `Are you sure you want to delete the template "${template.name}"?`,
                        onClick: () => template.id && removeTemplate(template.id),
                        icon: <TrashIcon className="w-5 h-5" />,
                      },
                    ]
                  : []),
              ]}
            />
          </div>
        </div>
        {template.description && <div className="text-white text-sm">{template.description}</div>}
      </div>
    </div>
  )
}
