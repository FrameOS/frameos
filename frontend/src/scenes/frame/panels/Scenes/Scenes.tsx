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
  EyeIcon,
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
import React, { useEffect, useRef } from 'react'
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
import { A, router } from 'kea-router'
import { urls } from '../../../../urls'
import { appsModel } from '../../../../models/appsModel'
import { chatLogic } from '../Chat/chatLogic'
export function Scenes() {
  const { frameId, frameForm, frame } = useValues(frameLogic)
  const { applyTemplate } = useActions(frameLogic)
  const { apps } = useValues(appsModel)
  const { editScene, openTemplates } = useActions(panelsLogic)
  const { selectedSceneId } = useValues(panelsLogic({ frameId }))
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
    linkedActiveSceneId,
    activeUploadedScene,
    missingActiveSceneId,
    missingActiveMatchesSearch,
    missingActiveExpanded,
    isUploadingImage,
    aiPrompt,
    aiError,
    isInstallingMissingActiveScene,
    previewingSceneId,
    focusedSceneId,
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
    previewScene,
    setAiPrompt,
    openAiScene,
    closeAiScene,
    generateAiSceneFailure,
    installMissingActiveScene,
  } = useActions(scenesLogic({ frameId }))
  const { startNewChatWithMessage } = useActions(chatLogic({ frameId, sceneId: selectedSceneId }))
  const { isSubmitting: isChatSubmitting } = useValues(chatLogic({ frameId, sceneId: selectedSceneId }))
  const { saveAsTemplate, saveAsZip } = useActions(templatesLogic({ frameId }))
  const { sceneChanging, loading, uploadedScenes, uploadedScenesLoading } = useValues(controlLogic({ frameId }))
  const { setCurrentScene, sync } = useActions(controlLogic({ frameId }))
  const { settings, savedSettings, settingsChanged, aiEmbeddingsStatus } = useValues(settingsLogic)
  const { setSettingsValue, submitSettings } = useActions(settingsLogic)
  const uploadInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!focusedSceneId) {
      return
    }
    const handle = requestAnimationFrame(() => {
      const element = document.querySelector(`[data-scene-id="${focusedSceneId}"]`)
      if (element instanceof HTMLElement) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    })
    return () => cancelAnimationFrame(handle)
  }, [focusedSceneId])
  const selectableSceneIds = filteredScenes.map((scene) => scene.id)
  const allSelectableScenesSelected =
    selectableSceneIds.length > 0 && selectableSceneIds.every((sceneId) => selectedSceneIds.has(sceneId))
  const promptSuggestions = [
    { label: 'Banana', prompt: 'Display an image of a banana on a white background. Do not use AI!' },
    { label: 'AI Banana', prompt: 'Display an image of a banana on a white background. Use AI!' },
    { label: 'Unsplash split', prompt: 'split the scene in 4 and show a different unsplash image in each of them' },
    {
      label: 'Health message',
      prompt:
        'create a scene that shows a random generated message each day. the message is about being healthy. show healthy things via unsplash in the background',
    },
    {
      label: 'Minimal clock',
      prompt:
        'Design a minimalist analog clock for an e-ink frame. On each render, render a single svg node (with autogenerated code) that shows the clock with hour minute and second hands as they currently are. Show numbers alongside the outer circle.',
    },
    { label: 'Weather panel', prompt: 'Show a clean weather dashboard with temperature, forecast, and icons.' },
    {
      label: 'Photo spotlight',
      prompt: 'Create a local photo spotlight with a caption and subtle border. Show image metadata on top.',
    },
  ]

  const onPromptDragOver = (event: React.DragEvent<HTMLTextAreaElement>) => {
    if (event.dataTransfer.types.includes('application/reactflow')) {
      event.preventDefault()
    }
  }

  const onPromptDrop = (event: React.DragEvent<HTMLTextAreaElement>) => {
    event.preventDefault()
    const data = event.dataTransfer.getData('application/reactflow')
    if (!data) {
      return
    }
    try {
      const { type, keyword } = JSON.parse(data)
      if (type !== 'app' || !keyword) {
        return
      }
      const appName = `[APP: ${apps[keyword]?.name ?? keyword}]`
      const nextPrompt = aiPrompt ? `${aiPrompt} ${appName}` : appName
      setAiPrompt(nextPrompt)
    } catch (error) {
      return
    }
  }

  const promptHoverState = useRef<{ previous: string | null; active: string | null }>({
    previous: null,
    active: null,
  })

  const handlePromptHoverEnter = (prompt: string) => {
    if (!hasEmbeddings) {
      return
    }
    if (promptHoverState.current.active === null) {
      promptHoverState.current.previous = aiPrompt ?? ''
    }
    promptHoverState.current.active = prompt
    setAiPrompt(prompt)
  }

  const handlePromptHoverLeave = (prompt: string) => {
    if (promptHoverState.current.active !== prompt) {
      return
    }
    const previous = promptHoverState.current.previous ?? ''
    promptHoverState.current.active = null
    promptHoverState.current.previous = null
    if (aiPrompt === prompt) {
      setAiPrompt(previous)
    }
  }

  const handlePromptSuggestionClick = (prompt: string) => {
    promptHoverState.current.active = null
    promptHoverState.current.previous = null
    setAiPrompt(prompt)
  }

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
  const hasBackendApiKey = Boolean(savedSettings?.openAI?.backendApiKey?.trim())
  const missingBackendApiKey = !hasBackendApiKey
  const serviceSettingKeys = Object.keys(settingsDetails)
  const missingServiceSettings = getMissingSecretSettingKeys(serviceSettingKeys, savedSettings)
  const orderedServiceKeys = [
    ...serviceSettingKeys.filter((settingKey) => !missingServiceSettings.has(settingKey)),
    ...serviceSettingKeys.filter((settingKey) => missingServiceSettings.has(settingKey)),
  ]
  const canSubmitAiPrompt = !isChatSubmitting && hasEmbeddings && !missingBackendApiKey

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
      {missingBackendApiKey ? (
        <div className="rounded-md border border-red-500/40 bg-red-950/40 p-3 text-xs text-red-200">
          <div className="font-semibold text-red-200">Missing OpenAI backend API key.</div>
          <p className="mt-1 text-red-200/80">Add the backend API key in Settings to enable AI scene generation.</p>
          <div className="mt-2">
            <Button size="small" color="secondary" onClick={() => router.actions.push(urls.settings())}>
              Fix in settings
            </Button>
          </div>
        </div>
      ) : null}
      <div className="space-y-1">
        <div className="text-xs font-semibold uppercase text-gray-400">Prompt</div>
        <TextArea
          rows={3}
          placeholder='e.g. "show an analog clock"'
          value={aiPrompt}
          onChange={setAiPrompt}
          onDragOver={onPromptDragOver}
          onDrop={onPromptDrop}
          disabled={!hasEmbeddings}
        />
        <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
          <span>Try:</span>
          {promptSuggestions.map((suggestion) => (
            <button
              key={suggestion.label}
              type="button"
              className="text-blue-300 hover:text-blue-200 hover:underline"
              onMouseEnter={() => handlePromptHoverEnter(suggestion.prompt)}
              onMouseLeave={() => handlePromptHoverLeave(suggestion.prompt)}
              onClick={() => handlePromptSuggestionClick(suggestion.prompt)}
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
        <div className="text-gray-400">
          Please note: Scene generation is still a work in progress. Generated scenes may not work well or may even
          crash your frame. Use with caution and always review the generated code. Progress logs will stream in the Chat
          panel.
        </div>
        <div className="flex items-center gap-2">
          {isChatSubmitting ? (
            <Tooltip title="A prompt is running">
              <div>
                <Button size="small" color="secondary" className="flex gap-1 items-center" disabled>
                  <Spinner color="white" />
                  Generating...
                </Button>
              </div>
            </Tooltip>
          ) : (
            <Button
              size="small"
              color="secondary"
              className="flex gap-1 items-center"
              onClick={() => {
                const trimmedPrompt = aiPrompt.trim()
                if (!trimmedPrompt) {
                  generateAiSceneFailure('Add a prompt to generate a scene.')
                  return
                }
                startNewChatWithMessage(`Build a new scene: ${trimmedPrompt}`, null)
              }}
              disabled={!canSubmitAiPrompt}
            >
              <SparklesIcon className="w-4 h-4" />
              Generate scene
            </Button>
          )}
          {!isChatSubmitting ? (
            <Button size="small" color="secondary" className="flex gap-1 items-center" onClick={closeAiScene}>
              Close
            </Button>
          ) : null}
        </div>
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
                      isUnsaved={true}
                      isUndeployed={true}
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
          const sceneServiceEntries = secretSettings.map((settingKey) => ({
            key: settingKey,
            label: settingsDetails[settingKey]?.title || settingKey,
            missing: missingSecretSettings.has(settingKey),
          }))
          const isSelected = selectedSceneIds.has(scene.id)
          const sceneHasChanges = unsavedSceneIds.has(scene.id) || undeployedSceneIds.has(scene.id)
          const isPreviewing = previewingSceneId === scene.id

          return (
            <React.Fragment key={scene.id}>
              <div
                data-scene-id={scene.id}
                className={clsx(
                  'border rounded-lg shadow bg-gray-900 break-inside-avoid p-2 space-y-1 transition',
                  linkedActiveSceneId === scene.id
                    ? 'border border-[#4a4b8c] shadow-[0_0_3px_3px_rgba(128,0,255,0.5)]'
                    : 'border-gray-700',
                  multiSelectEnabled && isSelected ? 'border-blue-400 shadow-[0_0_4px_2px_rgba(96,165,250,0.4)]' : null,
                  focusedSceneId === scene.id
                    ? 'border-sky-300 shadow-[0_0_6px_2px_rgba(56,189,248,0.45)] ring-1 ring-sky-300/70'
                    : null
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
                          {linkedActiveSceneId !== scene.id ? (
                            sceneHasChanges ? (
                              <Button
                                size="small"
                                className="!px-1"
                                color="secondary"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  previewScene(scene.id)
                                }}
                                disabled={isPreviewing}
                                title="Preview unsaved changes on the frame"
                              >
                                {isPreviewing ? (
                                  <Spinner color="white" className="w-5 h-5 flex items-center justify-center" />
                                ) : (
                                  <EyeIcon className="w-5 h-5" />
                                )}
                              </Button>
                            ) : (
                              <Button
                                size="small"
                                className="!px-1"
                                color="primary"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setCurrentScene(scene.id)
                                }}
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
                            )
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
                    <div className="flex flex-wrap items-center gap-2 pl-7 text-xs text-gray-500">
                      {sceneServiceEntries?.map(({ key, label, missing }) => (
                        <Tag key={key} color={missing ? 'orange' : 'teal'}>
                          {label}
                          {missing ? ' (missing key)' : ''}
                        </Tag>
                      ))}
                    </div>

                    {expandedScenes[scene.id] && !multiSelectEnabled ? (
                      <div className="pl-7">
                        <ExpandedScene
                          sceneId={scene.id}
                          frameId={frameId}
                          isUnsaved={unsavedSceneIds.has(scene.id)}
                          isUndeployed={undeployedSceneIds.has(scene.id)}
                        />
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
