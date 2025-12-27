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
import { Button } from '../../../../components/Button'
import { useEntityImage } from '../../../../models/entityImagesModel'
import { useMemo, useState } from 'react'
import clsx from 'clsx'
import { Tooltip } from '../../../../components/Tooltip'
import { appsModel } from '../../../../models/appsModel'
import { useActions, useValues } from 'kea'
import { AppConfig, FrameOSSettings } from '../../../../types'
import { Modal } from '../../../../components/Modal'
import { urls } from '../../../../urls'
import { settingsLogic } from '../../../settings/settingsLogic'
import { TextInput } from '../../../../components/TextInput'

const settingsDetails: Record<
  string,
  {
    title: string
    tagLabel: string
    description?: string
    fields: { label: string; secret?: boolean; path: (keyof FrameOSSettings | string)[] }[]
  }
> = {
  openAI: {
    title: 'OpenAI',
    tagLabel: 'Uses OpenAI API key',
    description: 'The OpenAI API key is used within OpenAI apps.',
    fields: [{ label: 'API key', secret: true, path: ['openAI', 'apiKey'] }],
  },
  unsplash: {
    title: 'Unsplash API',
    tagLabel: 'Uses Unsplash access key',
    fields: [{ label: 'Access key', secret: true, path: ['unsplash', 'accessKey'] }],
  },
  homeAssistant: {
    title: 'Home Assistant',
    tagLabel: 'Uses Home Assistant access token',
    fields: [
      { label: 'Home assistant URL', path: ['homeAssistant', 'url'] },
      {
        label: 'Access token (Profile → Long-Lived Access Tokens)',
        secret: true,
        path: ['homeAssistant', 'accessToken'],
      },
    ],
  },
  // frameOS: {
  //   title: 'FrameOS Gallery',
  //   tagLabel: 'Uses FrameOS Gallery API key',
  //   description: 'Premium AI slop to get you started.',
  //   fields: [{ label: 'API key', secret: true, path: ['frameOS', 'apiKey'] }],
  // },
}

function resolveAppConfig(apps: Record<string, AppConfig>, keyword?: string): AppConfig | undefined {
  if (!keyword) {
    return undefined
  }
  if (apps[keyword]) {
    return apps[keyword]
  }
  if (!keyword.includes('/')) {
    const match = Object.keys(apps).find((key) => key.endsWith(`/${keyword}`))
    if (match) {
      return apps[match]
    }
  }
  return undefined
}

function getSettingsValue(settings: FrameOSSettings | null | undefined, path: (keyof FrameOSSettings | string)[]) {
  return path.reduce<any>((acc, key) => (acc ? acc[key as keyof typeof acc] : undefined), settings)
}

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
  const { apps } = useValues(appsModel)
  const { settings, savedSettings, settingsChanged } = useValues(settingsLogic)
  const { setSettingsValue, submitSettings } = useActions(settingsLogic)
  const [activeSettingsKey, setActiveSettingsKey] = useState<string | null>(null)
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
  const secretSettings = useMemo(() => {
    const settingsKeys = new Set<string>()
    for (const scene of template.scenes ?? []) {
      for (const node of scene.nodes ?? []) {
        if (node.type === 'app') {
          const keyword = (node.data as { keyword?: string } | undefined)?.keyword
          const appConfig = resolveAppConfig(apps, keyword)
          for (const setting of appConfig?.settings ?? []) {
            if (settingsDetails[setting]) {
              settingsKeys.add(setting)
            }
          }
        }
      }
    }
    return Array.from(settingsKeys)
  }, [apps, template.scenes])
  const activeSettings = activeSettingsKey ? settingsDetails[activeSettingsKey] : null

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
          {secretSettings.length ? (
            <div className="flex flex-wrap gap-2 pt-1">
              {secretSettings.map((settingKey) => (
                <button
                  key={settingKey}
                  type="button"
                  className="inline-flex items-center rounded border border-gray-400/80 bg-gray-950 px-2 py-0.5 text-xs font-semibold uppercase text-gray-300 hover:bg-gray-900"
                  onClick={() => setActiveSettingsKey(settingKey)}
                >
                  {settingsDetails[settingKey].tagLabel}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      {activeSettings ? (
        <Modal title={`Global setting: ${activeSettings.title}`} onClose={() => setActiveSettingsKey(null)}>
          <div className="space-y-4 p-5 text-gray-100">
            <div className="rounded border border-orange-500/70 bg-gray-800 p-3">
              <div className="text-xs font-semibold uppercase text-orange-300">Global setting</div>
              <div className="text-sm text-orange-100">Changing this will affect all frames.</div>
            </div>
            {activeSettings.description ? <p className="text-sm text-gray-200">{activeSettings.description}</p> : null}
            <div className="space-y-2">
              <H6 className="text-base">{activeSettings.title}</H6>
              <div className="space-y-3">
                {activeSettings.fields.map((field) => {
                  const value = getSettingsValue(settings, field.path)
                  const hasValue =
                    value !== undefined && value !== null && (typeof value === 'string' ? value.trim() !== '' : true)
                  const savedValue = getSettingsValue(savedSettings, field.path)
                  const isSaved =
                    savedValue !== undefined &&
                    savedValue !== null &&
                    (typeof savedValue === 'string' ? savedValue.trim() !== '' : true)

                  return (
                    <div
                      key={field.label}
                      className="flex items-start gap-3 rounded border border-gray-600 px-3 py-3 text-sm"
                    >
                      <div
                        className={clsx(
                          'mt-0.5 flex h-6 w-6 items-center justify-center rounded border',
                          hasValue ? 'border-emerald-400 bg-emerald-500' : 'border-yellow-400 bg-yellow-500/20'
                        )}
                      >
                        {hasValue ? (
                          <CheckIcon className="h-4 w-4 text-emerald-950" />
                        ) : (
                          <ExclamationTriangleIcon className="h-4 w-4 text-yellow-300" />
                        )}
                      </div>
                      <div className="flex-1 space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span>{field.label}</span>
                          <div className="flex items-center gap-2">
                            {!isSaved ? (
                              <span className="rounded border border-yellow-400/80 bg-gray-900 px-2 py-0.5 text-xs font-semibold uppercase text-yellow-300">
                                Missing
                              </span>
                            ) : (
                              <span className="rounded border border-emerald-400/80 bg-gray-900 px-2 py-0.5 text-xs font-semibold uppercase text-emerald-300">
                                Saved
                              </span>
                            )}
                            {field.secret ? (
                              <span className="rounded border border-orange-400/80 bg-gray-900 px-2 py-0.5 text-xs font-semibold uppercase text-orange-300">
                                Secret
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <TextInput
                          type={field.secret ? 'password' : 'text'}
                          value={value ?? ''}
                          onChange={(nextValue) => setSettingsValue(field.path, nextValue)}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button size="small" color={settingsChanged ? 'primary' : 'secondary'} onClick={submitSettings}>
                Save global settings
              </Button>
              <Button size="small" color="secondary" onClick={() => (window.location.href = urls.settings())}>
                Open global settings
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  )
}
