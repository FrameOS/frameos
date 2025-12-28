import { useActions, useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { scenesLogic } from './scenesLogic'
import { Button } from '../../../../components/Button'
import { Box } from '../../../../components/Box'
import { DropdownMenu } from '../../../../components/DropdownMenu'
import { panelsLogic } from '../panelsLogic'
import { TextInput } from '../../../../components/TextInput'
import { Form } from 'kea-forms'
import { Field } from '../../../../components/Field'
import { H6 } from '../../../../components/H6'
import { Tag } from '../../../../components/Tag'
import {
  AdjustmentsHorizontalIcon,
  ArrowPathIcon,
  ArrowUpTrayIcon,
  CloudArrowDownIcon,
  ExclamationTriangleIcon,
  FolderArrowDownIcon,
  FolderOpenIcon,
  PencilSquareIcon,
  PlusIcon,
  Squares2X2Icon,
  SparklesIcon,
} from '@heroicons/react/24/outline'
import { templatesLogic } from '../Templates/templatesLogic'
import { SceneSettings } from './SceneSettings'
import React, { useRef, useState } from 'react'
import { SceneDropDown } from './SceneDropDown'
import { showAsFps } from '../../../../decorators/refreshInterval'
import clsx from 'clsx'
import { ChevronDownIcon, ChevronRightIcon, PlayIcon } from '@heroicons/react/24/solid'
import { Spinner } from '../../../../components/Spinner'
import { ExpandedScene } from './ExpandedScene'
import { controlLogic } from './controlLogic'
import { Tooltip } from '../../../../components/Tooltip'
import { FrameImage } from '../../../../components/FrameImage'
import { settingsLogic } from '../../../settings/settingsLogic'
import { getMissingSecretSettingKeys, settingsDetails } from '../secretSettings'
import { SecretSettingsModal } from '../SecretSettingsModal'
import { apiFetch } from '../../../../utils/apiFetch'
import { buildSdCardImageScene } from './sceneShortcuts'
import { v4 as uuidv4 } from 'uuid'

export function Scenes() {
  const { frameId, frameForm } = useValues(frameLogic)
  const { applyTemplate, sendEvent } = useActions(frameLogic)
  const { editScene, openTemplates } = useActions(panelsLogic)
  const {
    filteredScenes,
    scenes,
    search,
    showNewSceneForm,
    isNewSceneSubmitting,
    showingSettings,
    expandedScenes,
    otherScenesLinkingToScene,
    linksToOtherScenes,
    sceneTitles,
    undeployedSceneIds,
    unsavedSceneIds,
    sceneSecretSettings,
    activeSettingsKey,
    multiSelectEnabled,
    selectedSceneIds,
  } = useValues(scenesLogic({ frameId }))
  const {
    setSearch,
    toggleSettings,
    submitNewScene,
    toggleNewScene,
    createNewScene,
    closeNewScene,
    expandScene,
    setActiveSettingsKey,
    enableMultiSelect,
    disableMultiSelect,
    toggleSceneSelection,
    deleteSelectedScenes,
  } = useActions(scenesLogic({ frameId }))
  const { saveAsTemplate, saveAsZip } = useActions(templatesLogic({ frameId }))
  const { sceneId, sceneChanging, loading } = useValues(controlLogic({ frameId }))
  const { setCurrentScene, sync } = useActions(controlLogic({ frameId }))
  const { settings, savedSettings, settingsChanged } = useValues(settingsLogic)
  const { setSettingsValue, submitSettings } = useActions(settingsLogic)
  const [isUploadingImage, setIsUploadingImage] = useState(false)
  const uploadInputRef = useRef<HTMLInputElement>(null)

  const uploadImage = () => {
    uploadInputRef.current?.click()
  }

  const handleUploadImage = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }
    setIsUploadingImage(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const response = await apiFetch(`/api/frames/${frameId}/assets/upload_image`, {
        method: 'POST',
        body: formData,
      })
      if (!response.ok) {
        throw new Error('Image upload failed')
      }
      const payload = await response.json()
      const assetsPath = frameForm.assets_path || '/srv/assets'
      const relativePath = payload?.path || ''
      const filename = payload?.filename || relativePath.split('/').pop() || file.name
      const sceneId = uuidv4()
      const scene = buildSdCardImageScene(filename, assetsPath, sceneId)
      await sendEvent('uploadScene', { scenes: [scene], sceneId })
    } catch (error) {
      console.error(error)
      alert('Failed to upload image')
    } finally {
      setIsUploadingImage(false)
      event.target.value = ''
    }
  }

  const renderShortcuts = (className?: string, onNewScene: () => void = toggleNewScene) => (
    <div className={clsx('flex flex-wrap items-center gap-2 rounded-lg border border-gray-800 bg-gray-900/70 px-3 py-2', className)}>
      <span className="text-xs uppercase text-gray-400">Shortcuts</span>
      <Button size="small" color="secondary" className="flex gap-1 items-center" onClick={onNewScene}>
        <PlusIcon className="w-4 h-4" />
        New blank scene
      </Button>
      <Button size="small" color="secondary" className="flex gap-1 items-center" onClick={openTemplates}>
        <SparklesIcon className="w-4 h-4" />
        Explore available scenes
      </Button>
      <Button
        size="small"
        color="secondary"
        className="flex gap-1 items-center"
        onClick={uploadImage}
        disabled={isUploadingImage}
      >
        {isUploadingImage ? <Spinner color="white" /> : <ArrowUpTrayIcon className="w-4 h-4" />}
        Upload image
      </Button>
      <input ref={uploadInputRef} type="file" accept="image/*" className="hidden" onChange={handleUploadImage} />
    </div>
  )

  if (scenes.length === 0 && !showNewSceneForm) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center space-y-4 mb-8">
          <H6>No scenes installed yet</H6>
          <p className="text-gray-400">
            Scenes are the building blocks of your frame. They can be anything from a simple clock to a complex
            interactive thermostat.
          </p>
          {renderShortcuts('justify-center', createNewScene)}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {scenes.length > 0 ? (
          <>
            {renderShortcuts()}
            <div className="flex justify-between w-full items-center">
              <TextInput placeholder="Filter scenes..." className="flex-1 mr-2" onChange={setSearch} value={search} />
              <div className="flex gap-1">
                {multiSelectEnabled ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-300">{selectedSceneIds.size} selected</span>
                    <Button
                      size="small"
                      color="red"
                      disabled={selectedSceneIds.size === 0}
                      onClick={() => {
                        if (selectedSceneIds.size === 0) {
                          return
                        }
                        if (confirm('Are you sure you want to delete the selected scenes?')) {
                          deleteSelectedScenes()
                        }
                      }}
                    >
                      Delete selected
                    </Button>
                    <Button size="small" color="secondary" onClick={disableMultiSelect}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <>
                    <Button size="small" color="secondary" onClick={() => sync()} title="Sync active scene">
                      {loading ? <Spinner color="white" /> : <ArrowPathIcon className="w-5 h-5" />}
                    </Button>
                    <DropdownMenu
                      buttonColor="secondary"
                      className="mr-2"
                      items={[
                        {
                          label: 'Sync active scene',
                          onClick: () => sync(),
                          icon: <ArrowPathIcon className="w-5 h-5" />,
                        },
                        {
                          label: 'Save to "My scenes"',
                          onClick: () => saveAsTemplate({ name: frameForm.name }),
                          icon: <FolderArrowDownIcon className="w-5 h-5" />,
                        },
                        {
                          label: 'Download as .zip',
                          onClick: () => saveAsZip({ name: frameForm.name || 'Exported scenes' }),
                          icon: <CloudArrowDownIcon className="w-5 h-5" />,
                        },
                        {
                          label: 'Paste scene JSON',
                          onClick: () => {
                            const json = prompt('Paste your scene JSON here:')
                            if (json) {
                              try {
                                const scene = JSON.parse(json)
                                if (Array.isArray(scene)) {
                                  applyTemplate({ scenes: scene })
                                } else {
                                  applyTemplate({ scenes: [scene] })
                                }
                              } catch (error) {
                                alert('Invalid JSON')
                              }
                            }
                          },
                          icon: <FolderOpenIcon className="w-5 h-5" />,
                        },
                        {
                          label: 'Select multiple',
                          onClick: () => enableMultiSelect(),
                          icon: <Squares2X2Icon className="w-5 h-5" />,
                        },
                      ]}
                    />
                  </>
                )}
              </div>
            </div>
          </>
        ) : null}
        {filteredScenes.length === 0 && search ? (
          <div className="text-center text-gray-400">No scenes matching "{search}"</div>
        ) : null}
        {filteredScenes.map((scene) => {
          const secretSettings = sceneSecretSettings.get(scene.id) ?? []
          const missingSecretSettings = getMissingSecretSettingKeys(secretSettings, savedSettings)
          const isSelected = selectedSceneIds.has(scene.id)

          return (
            <React.Fragment key={scene.id}>
              <div
                className={clsx(
                  'border rounded-lg shadow bg-gray-900 break-inside-avoid p-2 space-y-1',
                  sceneId === scene.id
                    ? 'border border-[#4a4b8c] shadow-[0_0_3px_3px_rgba(128,0,255,0.5)]'
                    : 'border-gray-700',
                  multiSelectEnabled && isSelected ? 'border-blue-400 shadow-[0_0_4px_2px_rgba(96,165,250,0.4)]' : null
                )}
              >
                <div className="flex items-start justify-between gap-1">
                  <div className="overflow-hidden">
                    <FrameImage
                      frameId={frameId}
                      sceneId={scene.id}
                      className={clsx('max-w-[120px] max-h-[120px]', multiSelectEnabled ? '' : 'cursor-pointer')}
                      onClick={() => (multiSelectEnabled ? toggleSceneSelection(scene.id) : expandScene(scene.id))}
                      refreshable={false}
                      thumb
                      objectFit="cover"
                    />
                  </div>
                  <div className="break-inside-avoid space-y-1 w-full">
                    <div className="flex items-start justify-between gap-1">
                      {multiSelectEnabled ? (
                        <label className="mt-1 flex items-center">
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-gray-500 bg-gray-900 text-blue-400 focus:ring-blue-400"
                            checked={isSelected}
                            onChange={() => toggleSceneSelection(scene.id)}
                          />
                        </label>
                      ) : (
                        <div onClick={() => expandScene(scene.id)} className="cursor-pointer">
                          {expandedScenes[scene.id] ? (
                            <ChevronDownIcon className="w-6 h-6" />
                          ) : (
                            <ChevronRightIcon className="w-6 h-6" />
                          )}
                        </div>
                      )}
                      <div className="flex-1">
                        <H6
                          onClick={() => (multiSelectEnabled ? toggleSceneSelection(scene.id) : expandScene(scene.id))}
                          className="cursor-pointer"
                        >
                          {unsavedSceneIds.has(scene.id) ? '* ' : null}
                          <span className="cursor-pointer">{scene.name || scene.id}</span>
                          {undeployedSceneIds.has(scene.id) ? (
                            <Tooltip
                              containerClassName="inline-block align-middle"
                              title="This scene has saved changes that haven't been deployed to the frame yet."
                            >
                              <Tag className="ml-2" color="yellow">
                                <ExclamationTriangleIcon className="w-4 h-4 inline-block" />
                              </Tag>
                            </Tooltip>
                          ) : null}
                          {scene.settings?.execution !== 'interpreted' ? (
                            <Tooltip
                              containerClassName="inline-block align-middle"
                              title={
                                <>
                                  This is a compiled scene. All changes require a full redeploy. Click{' '}
                                  <PencilSquareIcon className="w-5 h-5 inline-block" /> and then
                                  <AdjustmentsHorizontalIcon className="w-5 h-5 inline-block" /> in to change.
                                </>
                              }
                            >
                              <Tag className="ml-2" color="none">
                                🕖 COMPILED
                              </Tag>
                            </Tooltip>
                          ) : null}
                          {scene.default ? (
                            <Tag className="ml-2" color="primary">
                              start on boot
                            </Tag>
                          ) : null}
                        </H6>
                      </div>
                      {!multiSelectEnabled ? (
                        <div className="flex gap-1">
                          {sceneId !== scene.id ? (
                            <Button
                              size="small"
                              className="!px-1"
                              color="primary"
                              onClick={(e) => {
                                e.stopPropagation()
                                setCurrentScene(scene.id)
                              }}
                              title="Activate"
                            >
                              {sceneChanging === scene.id ? (
                                <Spinner color="white" className="w-5 h-5 flex items-center justify-center" />
                              ) : (
                                <PlayIcon className="w-5 h-5" />
                              )}
                            </Button>
                          ) : (
                            <Tag
                              className="ml-2 cursor-pointer items-center inline-flex"
                              color="primary"
                              onClick={(e) => {
                                e.stopPropagation()
                                expandScene(scene.id)
                              }}
                            >
                              active
                            </Tag>
                          )}
                          <Button
                            size="small"
                            className="!px-1"
                            color="secondary"
                            onClick={(e) => {
                              e.stopPropagation()
                              editScene(scene.id)
                            }}
                            title="Edit"
                          >
                            <PencilSquareIcon className="w-5 h-5" />
                          </Button>
                          <SceneDropDown context="scenes" sceneId={scene.id} />
                        </div>
                      ) : null}
                    </div>

                    <div className="flex items-center gap-2 w-full pl-7 justify-between">
                      <div className="text-xs text-gray-400 flex flex-wrap gap-1 items-center">
                        <div>{scene.id}</div>
                        {secretSettings
                          .filter((settingKey) => missingSecretSettings.has(settingKey))
                          .map((settingKey) => (
                            <button
                              key={settingKey}
                              type="button"
                              className={clsx(
                                'inline-flex items-center rounded border border-gray-400/80 bg-gray-950 px-2 py-0.5 text-[10px] font-semibold uppercase text-gray-300',
                                multiSelectEnabled ? 'cursor-default opacity-60' : 'hover:bg-gray-900'
                              )}
                              onClick={() => {
                                if (!multiSelectEnabled) {
                                  setActiveSettingsKey(settingKey)
                                }
                              }}
                            >
                              <ExclamationTriangleIcon className="mr-1 h-3 w-3 text-yellow-300" />
                              {settingsDetails[settingKey].tagLabel}
                            </button>
                          ))}

                        {linksToOtherScenes[scene.id]?.size ? (
                          <Tooltip
                            title={
                              <div>
                                <div className="mb-2">This scene uses the following scenes:</div>
                                <ol>
                                  {Array.from(linksToOtherScenes[scene.id]).map((sceneId) => (
                                    <li
                                      key={sceneId}
                                      onClick={() => {
                                        if (!multiSelectEnabled) {
                                          editScene(sceneId)
                                        }
                                      }}
                                      className={clsx(
                                        'hover:underline',
                                        multiSelectEnabled ? 'cursor-default text-gray-500' : 'cursor-pointer'
                                      )}
                                    >
                                      {sceneTitles[sceneId] || sceneId}
                                    </li>
                                  ))}
                                </ol>
                              </div>
                            }
                          >
                            <Tag color="orange">+{linksToOtherScenes[scene.id].size} scenes</Tag>
                          </Tooltip>
                        ) : null}

                        {otherScenesLinkingToScene[scene.id]?.size ? (
                          <Tooltip
                            title={
                              <div>
                                <div className="mb-2">This scene is used by the following scenes:</div>
                                <ol>
                                  {Array.from(otherScenesLinkingToScene[scene.id]).map((sceneId) => (
                                    <li
                                      key={sceneId}
                                      onClick={() => {
                                        if (!multiSelectEnabled) {
                                          editScene(sceneId)
                                        }
                                      }}
                                      className={clsx(
                                        'hover:underline',
                                        multiSelectEnabled ? 'cursor-default text-gray-500' : 'cursor-pointer'
                                      )}
                                    >
                                      {sceneTitles[sceneId] || sceneId}
                                    </li>
                                  ))}
                                </ol>
                              </div>
                            }
                          >
                            <Tag color="blue">
                              Used by {otherScenesLinkingToScene[scene.id].size} scene
                              {otherScenesLinkingToScene[scene.id].size !== 1 ? 's' : ''}
                            </Tag>
                          </Tooltip>
                        ) : null}
                      </div>
                      {scene?.settings?.refreshInterval && Number.isFinite(scene.settings.refreshInterval) ? (
                        <div className="text-xs ml-2 uppercase">{showAsFps(scene.settings.refreshInterval)}</div>
                      ) : null}
                    </div>

                    {expandedScenes[scene.id] && !multiSelectEnabled ? (
                      <div className="pl-7">
                        <ExpandedScene sceneId={scene.id} frameId={frameId} />
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>

              {showingSettings[scene.id] && !multiSelectEnabled ? (
                <Box className="p-2 pl-4 pr-3 space-y-2 bg-gray-900 flex items-start justify-between gap-1 ml-4">
                  <SceneSettings sceneId={scene.id} onClose={() => toggleSettings(scene.id)} />
                </Box>
              ) : null}
            </React.Fragment>
          )
        })}

        {showNewSceneForm ? (
          <Form logic={scenesLogic} props={{ frameId }} formKey="newScene">
            <Box className="p-4 space-y-4 bg-gray-900">
              <H6>New scene</H6>
              <Field label="Name" name="name">
                <TextInput placeholder="e.g. Camera view" />
              </Field>
              <div className="flex gap-2">
                <Button size="small" color="primary" onClick={submitNewScene} disabled={isNewSceneSubmitting}>
                  Add Scene
                </Button>
                <Button size="small" color="secondary" className="flex gap-1 items-center" onClick={closeNewScene}>
                  Close
                </Button>
              </div>
            </Box>
          </Form>
        ) : (
          renderShortcuts()
        )}
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
    </div>
  )
}

Scenes.PanelTitle = function ScenesPanelTitle() {
  return <>Installed scenes</>
}
