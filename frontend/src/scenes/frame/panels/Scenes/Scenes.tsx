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
import React, { useRef } from 'react'
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
import { TextArea } from '../../../../components/TextArea'
import { A } from 'kea-router'
import { urls } from '../../../../urls'

export function Scenes() {
  const { frameId, frameForm, frame } = useValues(frameLogic)
  const { applyTemplate } = useActions(frameLogic)
  const { editScene, openTemplates } = useActions(panelsLogic)
  const {
    filteredScenes,
    scenes,
    search,
    newSceneFormLocation,
    aiSceneFormLocation,
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
    activeUploadedScene,
    missingActiveSceneId,
    missingActiveMatchesSearch,
    missingActiveExpanded,
    isUploadingImage,
    aiPrompt,
    aiError,
    aiSceneLastLog,
    aiSceneLogs,
    aiSceneLogsExpanded,
    isGeneratingAiScene,
    isInstallingMissingActiveScene,
  } = useValues(scenesLogic({ frameId }))
  const {
    setSearch,
    toggleSettings,
    submitNewScene,
    openNewScene,
    createNewScene,
    closeNewScene,
    expandScene,
    setActiveSettingsKey,
    enableMultiSelect,
    disableMultiSelect,
    toggleSceneSelection,
    setSelectedSceneIds,
    deleteSelectedScenes,
    toggleMissingActiveExpanded,
    uploadImage,
    setAiPrompt,
    generateAiScene,
    openAiScene,
    closeAiScene,
    toggleAiSceneLogsExpanded,
    installMissingActiveScene,
  } = useActions(scenesLogic({ frameId }))
  const { saveAsTemplate, saveAsZip } = useActions(templatesLogic({ frameId }))
  const { sceneId, sceneChanging, loading, uploadedScenes, uploadedScenesLoading } = useValues(
    controlLogic({ frameId })
  )
  const { setCurrentScene, sync } = useActions(controlLogic({ frameId }))
  const { settings, savedSettings, settingsChanged, aiEmbeddingsStatus } = useValues(settingsLogic)
  const { setSettingsValue, submitSettings } = useActions(settingsLogic)
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const selectableSceneIds = filteredScenes.map((scene) => scene.id)
  const allSelectableScenesSelected =
    selectableSceneIds.length > 0 && selectableSceneIds.every((sceneId) => selectedSceneIds.has(sceneId))
  const promptSuggestions = [
    { label: 'Banana', prompt: 'Display an image of a banana on a white background.' },
    {
      label: 'Health message',
      prompt:
        'create a scene that shows a random generated message each day. the message is about being healthy. show healthy things via unsplash in the background',
    },
    { label: 'Minimal clock', prompt: 'Design a minimalist analog clock for an e-ink frame.' },
    { label: 'Weather panel', prompt: 'Show a clean weather dashboard with temperature, forecast, and icons.' },
    { label: 'Photo spotlight', prompt: 'Create a photo spotlight with a caption and subtle border.' },
    { label: 'Daily quote', prompt: 'Display a large inspirational quote with author attribution.' },
  ]

  const triggerUploadInput = () => {
    uploadInputRef.current?.click()
  }

  const handleUploadImage = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }
    uploadImage(file)
    event.target.value = ''
  }

  const hasEmbeddings = (aiEmbeddingsStatus?.count ?? 0) > 0
  const hasAiSceneHistory =
    aiSceneLogs.length > 0 &&
    (isGeneratingAiScene || aiSceneLastLog?.status === 'success' || aiSceneLastLog?.status === 'error')

  const formatDurationSeconds = (durationMs: number | null) => {
    if (durationMs === null) {
      return null
    }
    const seconds = Math.max(0, durationMs / 1000)
    const roundedSeconds = Math.round(seconds * 10) / 10
    return `${roundedSeconds}s`
  }

  const aiSceneLogRows = aiSceneLogs.map((log, index) => {
    const start = new Date(log.timestamp).getTime()
    const end =
      index < aiSceneLogs.length - 1
        ? new Date(aiSceneLogs[index + 1].timestamp).getTime()
        : isGeneratingAiScene
        ? Date.now()
        : start
    const duration = Number.isNaN(start) || Number.isNaN(end) ? null : Math.max(0, end - start)
    return { log, duration }
  })

  const renderNewSceneForm = () => (
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
  )

  const renderAiSceneForm = () => (
    <Box className="p-4 space-y-3 bg-gray-900">
      <H6>Generate scene (alpha)</H6>
      <div className="space-y-1">
        <div className="text-xs font-semibold uppercase text-gray-400">Prompt</div>
        <TextArea
          rows={3}
          placeholder='e.g. "show an analog clock"'
          value={aiPrompt}
          onChange={setAiPrompt}
          disabled={!hasEmbeddings}
        />
        <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
          <span>Try:</span>
          {promptSuggestions.map((suggestion) => (
            <button
              key={suggestion.label}
              type="button"
              className="text-blue-300 hover:text-blue-200 hover:underline"
              onClick={() => setAiPrompt(suggestion.prompt)}
              disabled={!hasEmbeddings}
            >
              {suggestion.label}
            </button>
          ))}
        </div>
      </div>
      {!hasEmbeddings ? (
        <div className="text-xs text-gray-400">
          No embeddings generated.{' '}
          <A className="text-blue-400 hover:underline" href={urls.settings()}>
            Open settings
          </A>
        </div>
      ) : null}
      {aiError ? <span className="text-xs text-red-400">{aiError}</span> : null}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Button
            size="small"
            color="secondary"
            className="flex gap-1 items-center"
            onClick={() => generateAiScene()}
            disabled={isGeneratingAiScene || !hasEmbeddings}
          >
            {isGeneratingAiScene ? <Spinner color="white" /> : <SparklesIcon className="w-4 h-4" />}
            {isGeneratingAiScene ? 'Generating...' : 'Generate scene'}
          </Button>
          {!isGeneratingAiScene ? (
            <Button size="small" color="secondary" className="flex gap-1 items-center" onClick={closeAiScene}>
              Close
            </Button>
          ) : null}
          {hasAiSceneHistory ? (
            <button
              type="button"
              className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200"
              onClick={toggleAiSceneLogsExpanded}
              title={aiSceneLastLog?.message || (isGeneratingAiScene ? 'Awaiting updates.' : '')}
            >
              {aiSceneLogsExpanded ? <ChevronDownIcon className="h-4 w-4" /> : <ChevronRightIcon className="h-4 w-4" />}
              <span className="truncate max-w-[220px]">
                {aiSceneLastLog?.message || (isGeneratingAiScene ? 'Awaiting updates.' : '')}
              </span>
            </button>
          ) : null}
        </div>
        {hasAiSceneHistory && aiSceneLogsExpanded ? (
          <div className="rounded-md border border-gray-800 bg-gray-950/60 p-3">
            <ul className="space-y-1 text-xs text-gray-200">
              {aiSceneLogRows.map(({ log, duration }, index) => {
                const isLast = index === aiSceneLogRows.length - 1
                const durationLabel = isLast ? null : formatDurationSeconds(duration)
                return (
                  <li key={`${log.timestamp}-${index}`} className="flex flex-wrap items-baseline gap-2">
                    <span>{log.message}</span>
                    {durationLabel ? <span className="text-gray-500">{durationLabel}</span> : null}
                  </li>
                )
              })}
            </ul>
          </div>
        ) : null}
      </div>
    </Box>
  )

  const renderShortcuts = (
    location: string,
    className?: string,
    onNewScene: (() => void) | null = null,
    rightComponent: React.ReactNode = null
  ) => (
    <>
      <div className="flex items-top justify-between">
        <div className={clsx('flex flex-wrap items-center gap-2 rounded-lg', className)}>
          <Button
            size="small"
            color="secondary"
            className="flex gap-1 items-center"
            onClick={() => (onNewScene ? onNewScene() : openNewScene(location))}
          >
            <PlusIcon className="w-4 h-4" />
            New blank scene
          </Button>
          <Button
            size="small"
            color="secondary"
            className="flex gap-1 items-center"
            onClick={() => openAiScene(location)}
          >
            <SparklesIcon className="w-4 h-4" />
            Generate scene
          </Button>
          {!frame.scenes?.length ? (
            <Button size="small" color="secondary" className="flex gap-1 items-center" onClick={openTemplates}>
              <SparklesIcon className="w-4 h-4" />
              Explore available scenes
            </Button>
          ) : null}
          {frame.last_successful_deploy_at ? (
            <Button
              size="small"
              color="secondary"
              className="flex gap-1 items-center"
              onClick={triggerUploadInput}
              disabled={isUploadingImage}
            >
              {isUploadingImage ? <Spinner color="white" /> : <ArrowUpTrayIcon className="w-4 h-4" />}
              Upload image
            </Button>
          ) : null}
          <input ref={uploadInputRef} type="file" accept="image/*" className="hidden" onChange={handleUploadImage} />
        </div>
        {rightComponent ?? null}
      </div>
      {newSceneFormLocation === location ? renderNewSceneForm() : null}
      {aiSceneFormLocation === location ? renderAiSceneForm() : null}
    </>
  )

  if (scenes.length === 0 && !newSceneFormLocation && !missingActiveSceneId) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center space-y-4 mb-8">
          <H6>{frame.last_successful_deploy_at ? 'No scenes installed' : 'Not deployed yet'}</H6>
          <p className="text-gray-400">
            {frame.last_successful_deploy_at
              ? 'Scenes are the building blocks of your frame. They can be anything from a simple clock to a complex interactive thermostat.'
              : 'Press the purple "First deploy" button to deploy FrameOS for the first time.'}
          </p>
          {renderShortcuts('empty', 'justify-center', createNewScene)}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {scenes.length > 0 || missingActiveSceneId
          ? renderShortcuts(
              'top',
              undefined,
              null,
              <div className="flex justify-between items-center">
                <TextInput placeholder="Filter scenes..." className="mr-2" onChange={setSearch} value={search} />
                <div className="flex gap-1">
                  {multiSelectEnabled ? (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-300">{selectedSceneIds.size} selected</span>
                      <Button
                        size="small"
                        color="secondary"
                        disabled={selectableSceneIds.length === 0}
                        onClick={() => setSelectedSceneIds(allSelectableScenesSelected ? [] : selectableSceneIds)}
                      >
                        {allSelectableScenesSelected ? 'Clear all' : 'Select all'}
                      </Button>
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
                        Delete
                      </Button>
                      <Button size="small" color="secondary" onClick={disableMultiSelect} title="Exit multi-select">
                        X
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
            )
          : null}
        {filteredScenes.length === 0 && search && !missingActiveMatchesSearch ? (
          <div className="text-center text-gray-400">No scenes matching "{search}"</div>
        ) : null}
        {missingActiveMatchesSearch ? (
          <div
            className={clsx(
              'border rounded-lg shadow bg-gray-900 break-inside-avoid p-2 space-y-1 border-blue-700/60',
              missingActiveExpanded ? 'shadow-[0_0_3px_3px_rgba(128,0,255,0.3)]' : null
            )}
          >
            <div className="flex items-start justify-between gap-1">
              <div className="overflow-hidden">
                <FrameImage
                  frameId={frameId}
                  className="max-w-[120px] max-h-[120px]"
                  refreshable={false}
                  thumb
                  objectFit="cover"
                />
              </div>
              <div className="break-inside-avoid space-y-1 w-full">
                <div className="flex items-start justify-between gap-1">
                  <div onClick={toggleMissingActiveExpanded} className="cursor-pointer">
                    {missingActiveExpanded ? (
                      <ChevronDownIcon className="w-6 h-6" />
                    ) : (
                      <ChevronRightIcon className="w-6 h-6" />
                    )}
                  </div>
                  <div className="flex-1">
                    <H6 onClick={toggleMissingActiveExpanded} className="cursor-pointer">
                      {activeUploadedScene?.name || 'Active scene'}
                      <Tag className="ml-2" color="primary">
                        active
                      </Tag>
                      <Tag className="ml-2" color="orange">
                        not saved
                      </Tag>
                    </H6>
                  </div>
                  <div className="flex gap-1">
                    {uploadedScenes.length > 0 ? (
                      <Button
                        size="small"
                        color="secondary"
                        onClick={installMissingActiveScene}
                        disabled={uploadedScenesLoading || isInstallingMissingActiveScene}
                      >
                        {uploadedScenesLoading || isInstallingMissingActiveScene ? (
                          <Spinner color="white" />
                        ) : (
                          'Save on frame'
                        )}
                      </Button>
                    ) : null}
                  </div>
                </div>
                <div className="flex items-center gap-2 w-full pl-7 justify-between">
                  <div className="text-xs text-gray-400 flex flex-wrap gap-1 items-center">
                    <div>This scene is currently running, but it is not saved on the frame.</div>
                  </div>
                </div>
                {missingActiveExpanded && missingActiveSceneId ? (
                  <div className="pl-7">
                    <ExpandedScene
                      sceneId={missingActiveSceneId}
                      scene={activeUploadedScene}
                      frameId={frameId}
                      showEditButton={false}
                    />
                  </div>
                ) : null}
              </div>
            </div>
          </div>
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
                                if (unsavedSceneIds.has(scene.id) || undeployedSceneIds.has(scene.id)) {
                                  e.stopPropagation()
                                  return
                                }
                                e.stopPropagation()
                                setCurrentScene(scene.id)
                              }}
                              disabled={unsavedSceneIds.has(scene.id) || undeployedSceneIds.has(scene.id)}
                              title={
                                unsavedSceneIds.has(scene.id)
                                  ? 'Save this scene before running it.'
                                  : undeployedSceneIds.has(scene.id)
                                  ? 'Deploy this scene before running it.'
                                  : 'Activate'
                              }
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

        {renderShortcuts('bottom')}
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
