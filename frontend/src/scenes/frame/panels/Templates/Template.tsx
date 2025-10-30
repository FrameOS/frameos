import { TemplateType } from '../../../../types'
import { H6 } from '../../../../components/H6'
import { ArrowDownTrayIcon, PencilSquareIcon, TrashIcon } from '@heroicons/react/24/solid'
import { DropdownMenu } from '../../../../components/DropdownMenu'
import {
  FolderPlusIcon,
  CloudArrowDownIcon,
  DocumentPlusIcon,
  DocumentIcon,
  CheckIcon,
} from '@heroicons/react/24/outline'
import { Button } from '../../../../components/Button'
import { useEntityImage } from '../../../../models/entityImagesModel'
import { useMemo } from 'react'
import clsx from 'clsx'
import { Tooltip } from '../../../../components/Tooltip'

interface TemplateProps {
  template: TemplateType
  applyTemplate?: (template: TemplateType, wipe?: boolean) => void
  saveRemoteAsLocal?: (template: TemplateType) => void
  exportTemplate?: (id: string, format?: string) => void
  removeTemplate?: (id: string) => void
  editTemplate?: (template: TemplateType) => void
  installedTemplatesByName: Record<string, boolean>
}

export function TemplateRow({
  template,
  exportTemplate,
  removeTemplate,
  applyTemplate,
  editTemplate,
  saveRemoteAsLocal,
  installedTemplatesByName,
}: TemplateProps): JSX.Element {
  const imageEntity = useMemo(() => {
    if (template.id) {
      return `templates/${template.id}`
    }

    if (typeof template.image === 'string') {
      const match = template.image.match(
        /^\/api\/(repositories\/system\/[^/]+\/templates\/[^/]+)\/image$/
      )
      if (match) {
        return match[1]
      }
    }

    return null
  }, [template.id, template.image])

  // I know the order of hooks is weird here, but the "if" should never change for this component
  const { imageUrl: managedImageUrl } = useEntityImage(imageEntity, 'image')
  const fallbackImageUrl =
    managedImageUrl ?? (typeof template.image === 'string' ? template.image : null)
  const imageUrl = fallbackImageUrl

  return (
    <div
      className={clsx(
        '@container border rounded-lg shadow bg-gray-900 break-inside-avoid p-2 space-y-1',
        'border-gray-700'
      )}
    >
      <div className="flex items-start justify-between gap-2">
        {imageUrl ? (
          <Tooltip
            title={
              <a href={imageUrl} target="_blank" rel="noopener noreferrer">
                <img src={imageUrl} alt={template.name} />
              </a>
            }
          >
            <div
              className="w-[90px] h-[90px] border bg-cover bg-center flex-shrink-0 cursor-zoom-in"
              style={{ backgroundImage: `url(${JSON.stringify(imageUrl)})` }}
            />
          </Tooltip>
        ) : null}
        <div className="break-inside-avoid space-y-1 w-full">
          <div className="flex items-start justify-between gap-1 @xm:flex-col @md:flex-row">
            <div className="flex-1">
              <H6>{template.name}</H6>
            </div>
            <div className="flex gap-1">
              {applyTemplate ? (
                <Button
                  className="!px-2 flex gap-1"
                  size="small"
                  color={installedTemplatesByName[template.name] ? 'tertiary' : 'secondary'}
                  onClick={() => applyTemplate(template)}
                  title="Install scene"
                >
                  {!installedTemplatesByName[template.name] ? (
                    <FolderPlusIcon className="w-5 h-5" />
                  ) : (
                    <CheckIcon className="w-5 h-5" />
                  )}
                  <span className="hidden @xs:inline">
                    {installedTemplatesByName[template.name] ? (
                      'Installed'
                    ) : (
                      <>Install{(template.scenes || []).length > 1 ? ` (${(template.scenes || []).length})` : ''}</>
                    )}
                  </span>
                </Button>
              ) : null}
              <DropdownMenu
                buttonColor="secondary"
                items={[
                  ...(applyTemplate
                    ? [
                        {
                          label:
                            'scenes' in template && Array.isArray(template.scenes)
                              ? `Install ${(template.scenes || []).length} scene${
                                  (template.scenes || []).length === 1 ? '' : 's'
                                } onto frame`
                              : 'Install onto frame',
                          onClick: () => applyTemplate(template),
                          icon: <DocumentPlusIcon className="w-5 h-5" />,
                        },
                        {
                          label: `Clear frame & install`,
                          confirm: 'Are you sure? This will erase all scenes from the frame and install this template.',
                          onClick: () => applyTemplate(template, true),
                          icon: <DocumentIcon className="w-5 h-5" />,
                        },
                      ]
                    : []),
                  ...(saveRemoteAsLocal
                    ? [
                        {
                          label: 'Save to "My scenes"',
                          onClick: () => saveRemoteAsLocal(template),
                          icon: <ArrowDownTrayIcon className="w-5 h-5" />,
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

          <div className="flex items-center gap-2 w-full justify-between">
            {template.description && <div className="text-white text-sm">{template.description}</div>}
          </div>
        </div>
      </div>
    </div>
  )
}
