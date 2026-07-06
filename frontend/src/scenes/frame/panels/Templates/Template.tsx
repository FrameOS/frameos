import { TemplateType } from '../../../../types'
import { H6 } from '../../../../components/H6'
import {
  ArrowDownTrayIcon,
  PencilSquareIcon,
  TrashIcon,
  ExclamationTriangleIcon,
  StarIcon as StarSolidIcon,
} from '@heroicons/react/24/solid'
import { DropdownMenu } from '../../../../components/DropdownMenu'
import {
  FolderPlusIcon,
  CloudArrowDownIcon,
  DocumentPlusIcon,
  CheckIcon,
  EyeIcon,
  StarIcon as StarOutlineIcon,
} from '@heroicons/react/24/outline'
import { Button } from '../../../../components/Button'
import { useEntityImage } from '../../../../models/entityImagesModel'
import { useMemo, useState } from 'react'
import clsx from 'clsx'
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
import { type FrameosTemplateDragData, setFrameosTemplateDragData } from '../../../workspace/sceneDrag'
import type { CompatibilityResult } from '../../../../utils/embeddedCompatibility'

interface TemplateProps {
  template: TemplateType
  frameId?: number
  applyTemplate?: (template: TemplateType) => void
  saveRemoteAsLocal?: (template: TemplateType) => void
  exportTemplate?: (id: string, format?: string) => void
  removeTemplate?: (id: string) => void
  editTemplate?: (template: TemplateType) => void
  installedTemplatesByName: Record<string, boolean>
  templateDragData?: FrameosTemplateDragData
  compatibility?: CompatibilityResult
  favourite?: boolean
  favouriteId?: string
  onToggleFavourite?: (favouriteId: string) => void
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
  templateDragData,
  compatibility,
  favourite,
  favouriteId,
  onToggleFavourite,
}: TemplateProps): JSX.Element {
  const { apps } = useValues(appsModel)
  const { settings, savedSettings, settingsChanged } = useValues(settingsLogic)
  const { setSettingsValue, submitSettings } = useActions(settingsLogic)
  const [activeSettingsKey, setActiveSettingsKey] = useState<string | null>(null)
  const {
    trySceneConfig,
    trySceneModalOpen,
    visibleTrySceneFields,
    trySceneState,
    scenes: templateScenes,
    canLoadRemoteScenes,
  } = useValues(templateRowLogic({ frameId, template }))
  const { startTryScene, closeTrySceneModal, submitTrySceneState } = useActions(templateRowLogic({ frameId, template }))
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
  const secretSettings = useMemo(() => collectSecretSettingsFromScenes(templateScenes, apps), [apps, templateScenes])
  const missingSecretSettings = useMemo(
    () => getMissingSecretSettingKeys(secretSettings, savedSettings),
    [savedSettings, secretSettings]
  )
  const unsupported = compatibility?.supported === false
  const unsupportedReason = compatibility?.reason ?? 'This scene is not supported on ESP32 frames.'
  const canInstall = !unsupported

  return (
    <div
      draggable={Boolean(templateDragData) && canInstall}
      onDragStart={(event) => {
        if (!canInstall) {
          event.preventDefault()
          return
        }
        if (templateDragData) {
          setFrameosTemplateDragData(event.dataTransfer, templateDragData)
        }
      }}
      title={unsupported ? unsupportedReason : undefined}
      className={clsx(
        'frame-tool-card @container break-inside-avoid space-y-2 rounded-[18px] p-3 transition',
        templateDragData && canInstall && 'cursor-grab active:cursor-grabbing',
        unsupported && 'opacity-60 grayscale'
      )}
    >
      <div className="flex items-start justify-between gap-2">
        {imageUrl ? (
          <div
            className={clsx(
              'h-[90px] w-[90px] flex-shrink-0 rounded-2xl border border-slate-500/20 bg-cover bg-center',
              templateDragData && canInstall && 'cursor-grab active:cursor-grabbing'
            )}
            style={{ backgroundImage: `url(${JSON.stringify(imageUrl)})` }}
          />
        ) : null}
        <div className="break-inside-avoid space-y-1 w-full">
          <div className="flex flex-col items-start justify-between gap-1 @md:flex-row">
            <div className="flex-1">
              <H6>{template.name}</H6>
            </div>
            <div className="flex gap-1">
              {applyTemplate ? (
                <Button
                  className="!px-2 flex gap-1"
                  size="small"
                  color={installedTemplatesByName[template.name] ? 'secondary' : 'primary'}
                  onClick={() => applyTemplate(template)}
                  disabled={!canInstall}
                  title={unsupported ? unsupportedReason : 'Add scene'}
                >
                  {!installedTemplatesByName[template.name] ? (
                    <FolderPlusIcon className="w-5 h-5" />
                  ) : (
                    <CheckIcon className="w-5 h-5" />
                  )}
                  <span className="hidden @xs:inline">
                    {installedTemplatesByName[template.name] ? (
                      'Added'
                    ) : (
                      <>Add{templateScenes.length > 1 ? ` (${templateScenes.length})` : ''}</>
                    )}
                  </span>
                </Button>
              ) : null}
              {trySceneConfig || canLoadRemoteScenes ? (
                <Button
                  className="!px-2 flex gap-1"
                  size="small"
                  color="secondary"
                  onClick={() => {
                    if (!canInstall) {
                      return
                    }
                    startTryScene()
                  }}
                  disabled={!frameId || !canInstall}
                  title={unsupported ? unsupportedReason : 'Preview this interpreted scene on the frame'}
                >
                  <EyeIcon className="w-5 h-5" />
                </Button>
              ) : null}
              {favouriteId && onToggleFavourite ? (
                <Button
                  className="!px-2 flex gap-1"
                  size="small"
                  color="secondary"
                  aria-label={favourite ? 'Remove from personal favourites' : 'Add to personal favourites'}
                  aria-pressed={favourite}
                  title={favourite ? 'Remove from personal favourites' : 'Add to personal favourites'}
                  onClick={() => onToggleFavourite(favouriteId)}
                >
                  {favourite ? (
                    <StarSolidIcon className="h-5 w-5 text-amber-400" />
                  ) : (
                    <StarOutlineIcon className="h-5 w-5" />
                  )}
                </Button>
              ) : null}
              <DropdownMenu
                buttonColor="secondary"
                items={[
                  ...(applyTemplate
                    ? [
                        {
                          label: templateScenes.length
                            ? `Add ${templateScenes.length} scene${templateScenes.length === 1 ? '' : 's'} onto frame`
                            : 'Add onto frame',
                          onClick: () => applyTemplate(template),
                          disabled: !canInstall,
                          title: unsupported ? unsupportedReason : undefined,
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
            {template.description ? <div className="frame-tool-muted text-sm">{template.description}</div> : null}
          </div>
          {unsupported ? (
            <div className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600">
              Not supported on ESP32: {unsupportedReason}
            </div>
          ) : null}
          {missingSecretSettings.size ? (
            <div className="flex flex-wrap gap-2 pt-1">
              {secretSettings
                .filter((settingKey) => missingSecretSettings.has(settingKey))
                .map((settingKey) => (
                  <button
                    key={settingKey}
                    type="button"
                    className="inline-flex items-center rounded-full border border-amber-400/40 bg-amber-500/10 px-2 py-0.5 text-xs font-semibold uppercase text-amber-500 hover:bg-amber-500/15"
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
          title={`Preview "${trySceneConfig.mainScene.name || template.name}"`}
        >
          <Form
            logic={templateRowLogic}
            props={{ frameId, template }}
            formKey="trySceneState"
            className="space-y-4 p-5"
          >
            {visibleTrySceneFields.length ? (
              <div className="space-y-2 @container">
                {visibleTrySceneFields.map((field) => (
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
              <div className="frame-tool-muted text-sm">This scene does not export publicly controllable state.</div>
            )}
            <div className="flex justify-end gap-2 border-t border-slate-500/20 pt-4">
              <Button onClick={closeTrySceneModal} color="secondary">
                Cancel
              </Button>
              <Button onClick={submitTrySceneState} color="primary" disabled={!frameId}>
                Preview scene
              </Button>
            </div>
          </Form>
        </Modal>
      ) : null}
    </div>
  )
}
