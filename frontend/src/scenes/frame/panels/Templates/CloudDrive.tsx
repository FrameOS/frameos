import { useActions, useValues } from 'kea'
import { A } from 'kea-router'
import { ArrowPathIcon, ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/24/solid'
import { H6 } from '../../../../components/H6'
import { Box } from '../../../../components/Box'
import { Spinner } from '../../../../components/Spinner'
import { DropdownMenu } from '../../../../components/DropdownMenu'
import { frameLogic } from '../../frameLogic'
import { appsModel } from '../../../../models/appsModel'
import { templatesLogic } from './templatesLogic'
import { cloudDriveLogic } from './cloudDriveLogic'
import { TemplateRow } from './Template'
import { templateCompatibilityForFrame } from '../../../../utils/embeddedCompatibility'
import { searchInText } from '../../../../utils/searchInText'
import { urls } from '../../../../urls'

const EXPANDED_KEY = 'cloud-drive'

interface CloudDriveProps {
  openInstalledSceneDrawer?: boolean
}

/** "My cloud drive" section of the Templates panel: your own FrameOS Cloud
 * store scenes (private and public), installable on any frame. Shows a short
 * promo with a settings link while the cloud is not connected. */
export function CloudDrive({ openInstalledSceneDrawer = false }: CloudDriveProps): JSX.Element {
  const { frameId, mode, frameForm } = useValues(frameLogic)
  const { apps } = useValues(appsModel)
  const { isExpanded, search, installedTemplatesByName } = useValues(templatesLogic({ frameId }))
  const { toggleExpanded, applyRemoteToFrame, saveRemoteAsLocal } = useActions(templatesLogic({ frameId }))
  const { driveTemplates, driveTemplatesLoading, hasDriveScope, cloudConnected, driveRepository } =
    useValues(cloudDriveLogic)
  const { loadDrive } = useActions(cloudDriveLogic)

  const expanded = isExpanded(EXPANDED_KEY)
  const templates =
    search === ''
      ? driveTemplates
      : driveTemplates.filter((t) => searchInText(search, t.name) || searchInText(search, t.description))

  return (
    <div className="space-y-2">
      <div className="flex justify-between w-full items-center">
        <H6 className="flex cursor-pointer items-center gap-1" onClick={() => toggleExpanded(EXPANDED_KEY)}>
          {expanded ? <ChevronDownIcon className="w-6 h-6" /> : <ChevronRightIcon className="w-6 h-6" />}
          My cloud drive
          {hasDriveScope && driveTemplates.length ? ` (${driveTemplates.length})` : ''}
          {driveTemplatesLoading ? <Spinner className="ml-1 h-4 w-4" /> : null}
        </H6>
        {hasDriveScope ? (
          <DropdownMenu
            buttonColor="secondary"
            className="mr-3"
            items={[
              {
                label: 'Refresh',
                onClick: loadDrive,
                icon: <ArrowPathIcon className="w-5 h-5" />,
              },
            ]}
          />
        ) : null}
      </div>
      {expanded ? (
        !hasDriveScope ? (
          <Box className="frame-tool-card rounded-[18px] p-3 text-sm space-y-1">
            <div>
              Save scenes to your own private drive on FrameOS Cloud, restore them on any install, and share the best
              ones on the public store.
            </div>
            <div className="frame-tool-muted">
              {cloudConnected ? (
                <>
                  This comes with your cloud account — reconnect in{' '}
                  <A href={urls.settings()} className="underline">
                    Settings → FrameOS Cloud
                  </A>{' '}
                  to pick it up.
                </>
              ) : (
                <>
                  <A href={urls.settings()} className="underline">
                    Connect FrameOS Cloud
                  </A>{' '}
                  in Settings to use it.
                </>
              )}
            </div>
          </Box>
        ) : (
          <div className="space-y-2">
            {templates
              .map((template, index) => ({
                template,
                index,
                compatibility: templateCompatibilityForFrame(mode, template, apps, frameForm),
              }))
              .toSorted((a, b) => a.template.name.localeCompare(b.template.name))
              .map(({ template, index, compatibility }) => (
                <TemplateRow
                  key={template.sceneId ?? template.id ?? -index}
                  template={template}
                  frameId={frameId}
                  repository={driveRepository}
                  saveRemoteAsLocal={(template) => saveRemoteAsLocal(driveRepository, template)}
                  applyTemplate={(template) => {
                    applyRemoteToFrame(driveRepository, template, openInstalledSceneDrawer)
                  }}
                  installedTemplatesByName={installedTemplatesByName}
                  templateDragData={
                    compatibility.supported
                      ? {
                          template,
                          repository: {
                            id: driveRepository.id,
                            name: driveRepository.name,
                            url: driveRepository.url,
                          },
                        }
                      : undefined
                  }
                  compatibility={compatibility}
                />
              ))}
            {templates.length === 0 && !driveTemplatesLoading ? (
              <div className="frame-tool-muted rounded-xl px-3 py-2 text-sm">
                {search === ''
                  ? 'Your cloud drive is empty. Use "Save to cloud drive" on any scene to fill it.'
                  : `No cloud drive scenes match "${search}"`}
              </div>
            ) : null}
          </div>
        )
      ) : null}
    </div>
  )
}
