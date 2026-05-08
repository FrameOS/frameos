import { TemplateType } from '../../../../types'
import { H6 } from '../../../../components/H6'
import { ArrowDownTrayIcon, PencilSquareIcon, TrashIcon, ExclamationTriangleIcon } from '@heroicons/react/24/solid'
import { DropdownMenu } from '../../../../components/DropdownMenu'
import {
  FolderPlusIcon,
  CloudArrowDownIcon,
  DocumentPlusIcon,
  DocumentIcon,
  CheckIcon,
} from '@heroicons/react/24/outline'
import { PlayIcon } from '@heroicons/react/24/solid'
import { Button } from '../../../../components/Button'
import { useEntityImage } from '../../../../models/entityImagesModel'
import { useMemo, useState } from 'react'
import clsx from 'clsx'
import { Tooltip } from '../../../../components/Tooltip'
import { appsModel } from '../../../../models/appsModel'
import { useActions, useValues } from 'kea'
import { settingsLogic } from '../../../settings/settingsLogic'
import { collectSecretSettingsFromScenes, getMissingSecretSettingKeys, settingsDetails } from '../secretSettings'
import { SecretSettingsModal } from '../SecretSettingsModal'
import { templateRowLogic } from './templateRowLogic'
import { Modal } from '../../../../components/Modal'
import { Form } from 'kea-forms'
import { Field } from '../../../../components/Field'
import { StateFieldEdit } from '../Scenes/StateFieldEdit'

interface TemplateProps {
  template: TemplateType
  frameId?: number
  applyTemplate?: (template: TemplateType) => void
  saveRemoteAsLocal?: (template: TemplateType) => void
  exportTemplate?: (id: string, format?: string) => void
  removeTemplate?: (id: string) => void
  editTemplate?: (template: TemplateType) => void
  installedTemplatesByName: Record<string, boolean>
}

export function TemplateRow({
  template,
  frameId,
  exportTemplate,
  removeTemplate,
  applyTemplate,
  editTemplate,
  saveRemoteAsLocal,
  installedTemplatesByName,
}: TemplateProps): JSX.Element {
  const { apps } = useValues(appsModel)
  const { settings, savedSettings, settingsChanged } = useValues(settingsLogic)
  const { setSettingsValue, submitSettings } = useActions(settingsLogic)
  const [activeSettingsKey, setActiveSettingsKey] = useState<string | null>(null)
  const { trySceneConfig, tryLoading, trySceneModalOpen, trySceneFields, trySceneState } = useValues(
    templateRowLogic({ frameId, template })
  )
  const { openTrySceneModal, closeTrySceneModal, submitTrySceneState, resetTrySceneState } = useActions(
    templateRowLogic({ frameId, template })
  )
  const imageEntity = useMemo(() => {
    if (template.id) {
      return `templates/${template.id}`
    }

    if (typeof template.image === 'string') {
      const match = template.image.match(/^\/api\/(repositories\/system\/[^/]+\/templates\/[^/]+)\/image$/)
      if (match) {
        return match[1]
      }
    }

    return null
  }, [template.id, template.image])

  // I know the order of hooks is weird here, but the "if" should never change for this component
  const { imageUrl: managedImageUrl } = useEntityImage(imageEntity, 'image')
  const fallbackImageUrl = managedImageUrl ?? (typeof template.image === 'string' ? template.image : null)
  const imageUrl = fallbackImageUrl
  const secretSettings = useMemo(
    () => collectSecretSettingsFromScenes(template.scenes ?? [], apps),
    [apps, template.scenes]
  )
  const missingSecretSettings = useMemo(
    () => getMissingSecretSettingKeys(secretSettings, savedSettings),
    [savedSettings, secretSettings]
  )

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
              {trySceneConfig ? (
                <Button
                  className="!px-2 flex gap-1"
                  size="small"
                  color="primary"
                  onClick={() => {
                    if (trySceneFields.length === 0) {
                      resetTrySceneState({})
                      submitTrySceneState()
                      return
                    }
                    openTrySceneModal()
                  }}
                  disabled={tryLoading || !frameId}
                  title="Run this interpreted scene on the frame"
                >
                  <PlayIcon className="w-5 h-5" />
                </Button>
              ) : null}
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
          {missingSecretSettings.size ? (
            <div className="flex flex-wrap gap-2 pt-1">
              {secretSettings
                .filter((settingKey) => missingSecretSettings.has(settingKey))
                .map((settingKey) => (
                  <button
                    key={settingKey}
                    type="button"
                    className="inline-flex items-center rounded border border-gray-400/80 bg-gray-950 px-2 py-0.5 text-xs font-semibold uppercase text-gray-300 hover:bg-gray-900"
                    onClick={() => setActiveSettingsKey(settingKey)}
                  >
                    <ExclamationTriangleIcon className="mr-1 h-3 w-3 text-yellow-300" />
                    {settingsDetails[settingKey].tagLabel}
                  </button>
                ))}
            </div>
          ) : null}
        </div>
      </div>
      <SecretSettingsModal
        activeSettingsKey={activeSettingsKey}
        onClose={() => setActiveSettingsKey(null)}
        settings={settings}
        savedSettings={savedSettings}
        settingsChanged={settingsChanged}
        setSettingsValue={setSettingsValue}
        submitSettings={submitSettings}
      />
      {trySceneConfig ? (
        <Modal
          open={trySceneModalOpen}
          onClose={closeTrySceneModal}
          title={`Run "${trySceneConfig.mainScene.name || template.name}"`}
        >
          <Form
            logic={templateRowLogic}
            props={{ frameId, template }}
            formKey="trySceneState"
            className="space-y-4 p-5"
          >
            {trySceneFields.length ? (
              <div className="space-y-2 @container">
                {trySceneFields.map((field) => (
                  <Field key={field.name} name={field.name} label={field.label || field.name}>
                    {({ value, onChange }) => (
                      <StateFieldEdit
                        field={field}
                        value={value}
                        onChange={onChange}
                        currentState={{}}
                        stateChanges={trySceneState}
                      />
                    )}
                  </Field>
                ))}
              </div>
            ) : (
              <div>This scene does not export publicly controllable state.</div>
            )}
            <div className="flex justify-end gap-2 border-t border-gray-600 pt-4">
              <Button onClick={closeTrySceneModal} color="secondary">
                Cancel
              </Button>
              <Button onClick={submitTrySceneState} color="primary" disabled={tryLoading}>
                {tryLoading ? 'Running…' : 'Run scene'}
              </Button>
            </div>
          </Form>
        </Modal>
      ) : null}
    </div>
  )
}
