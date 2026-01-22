import { actions, afterMount, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'
import type { scenesLogicType } from './scenesLogicType'
import { FrameScene, Panel, SceneNodeData } from '../../../../types'
import { frameLogic, sanitizeScene } from '../../frameLogic'
import { appsModel } from '../../../../models/appsModel'
import { forms } from 'kea-forms'
import { v4 as uuidv4 } from 'uuid'
import { panelsLogic } from '../panelsLogic'
import { controlLogic } from './controlLogic'
import equal from 'fast-deep-equal'
import { collectSecretSettingsFromScenes } from '../secretSettings'
import { apiFetch } from '../../../../utils/apiFetch'
import { buildSdCardImageScene } from './sceneShortcuts'
import { socketLogic } from '../../../socketLogic'

export interface ScenesLogicProps {
  frameId: number
}

const UPLOADED_SCENE_PREFIX = 'uploaded/'

const applyStateToSceneFields = (scene: FrameScene, state: Record<string, any> | null): FrameScene => {
  if (!state || !scene.fields?.length) {
    return scene
  }
  const fields = scene.fields.map((field) => {
    if (!field?.name) {
      return field
    }
    if (Object.prototype.hasOwnProperty.call(state, field.name)) {
      return { ...field, value: String(state[field.name]) }
    }
    return field
  })
  return { ...scene, fields }
}

export const scenesLogic = kea<scenesLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Scenes', 'scenesLogic']),
  props({} as ScenesLogicProps),
  key((props) => props.frameId),
  connect(({ frameId }: ScenesLogicProps) => ({
    logic: [socketLogic],
    values: [
      frameLogic({ frameId }),
      ['frame', 'frameForm', 'lastDeploy'],
      appsModel,
      ['apps'],
      controlLogic({ frameId }),
      ['sceneId as activeSceneId', 'uploadedScenes', 'uploadedScenesLoading', 'states'],
    ],
    actions: [
      frameLogic({ frameId }),
      ['applyTemplate', 'sendEvent'],
      panelsLogic({ frameId }),
      ['editScene', 'closePanel'],
      controlLogic({ frameId }),
      ['sync as syncActiveScene'],
    ],
  })),
  actions({
    toggleSettings: (sceneId: string) => ({ sceneId }),
    setAsDefault: (sceneId: string) => ({ sceneId }),
    removeDefault: true,
    deleteScene: (sceneId: string) => ({ sceneId }),
    deleteSelectedScenes: true,
    renameScene: (sceneId: string) => ({ sceneId }),
    duplicateScene: (sceneId: string) => ({ sceneId }),
    openNewScene: (location: string) => ({ location }),
    closeNewScene: true,
    createNewScene: true,
    openAiScene: (location: string) => ({ location }),
    closeAiScene: true,
    sync: true,
    expandScene: (sceneId: string) => ({ sceneId }),
    copySceneJSON: (sceneId: string) => ({ sceneId }),
    setSearch: (search: string) => ({ search }),
    setActiveSettingsKey: (activeSettingsKey: string | null) => ({ activeSettingsKey }),
    enableMultiSelect: true,
    disableMultiSelect: true,
    clearSceneSelection: true,
    toggleSceneSelection: (sceneId: string) => ({ sceneId }),
    setSelectedSceneIds: (sceneIds: string[]) => ({ sceneIds }),
    toggleMissingActiveExpanded: true,
    uploadImage: (file: File) => ({ file }),
    uploadImageSuccess: true,
    uploadImageFailure: true,
    previewScene: (sceneId: string, state?: Record<string, any> | null) => ({ sceneId, state }),
    previewSceneSuccess: true,
    previewSceneFailure: true,
    setAiPrompt: (prompt: string) => ({ prompt }),
    generateAiScene: true,
    generateAiSceneSuccess: true,
    generateAiSceneFailure: (error: string) => ({ error }),
    setAiSceneRequestId: (requestId: string | null) => ({ requestId }),
    setAiSceneLogMessage: (log: {
      requestId: string
      message: string
      status?: string
      stage?: string
      timestamp: string
    }) => ({
      log,
    }),
    toggleAiSceneLogsExpanded: true,
    setAiSceneLogsExpanded: (expanded: boolean) => ({ expanded }),
    installMissingActiveScene: true,
    installMissingActiveSceneSuccess: true,
    installMissingActiveSceneFailure: true,
    focusScene: (sceneId: string) => ({ sceneId }),
    clearFocusedScene: true,
  }),
  forms(({ actions, values, props }) => ({
    newScene: {
      defaults: {
        name: '',
      },
      errors: (values) => ({
        name: !values.name ? 'Name is required' : undefined,
      }),
      submit: ({ name }, breakpoint) => {
        const scenes: FrameScene[] = values.frameForm.scenes || []
        const id = uuidv4()
        frameLogic({ frameId: props.frameId }).actions.setFrameFormValues({
          scenes: [
            ...scenes,
            sanitizeScene(
              {
                id,
                name,
                nodes: [
                  {
                    id: '463556ab-e4fe-40c7-93f3-40bc723f454e',
                    type: 'event',
                    position: {
                      x: 121,
                      y: 113,
                    },
                    data: {
                      keyword: 'render',
                    },
                    width: 99,
                    height: 40,
                  },
                ],
                edges: [],
                fields: [],
                settings: { execution: 'interpreted' },
              },
              values.frameForm
            ),
          ],
        })
        actions.editScene(id)
        actions.resetNewScene()
      },
    },
  })),
  reducers({
    search: [
      '',
      {
        setSearch: (_, { search }) => search,
      },
    ],
    newSceneFormLocation: [
      null as string | null,
      {
        openNewScene: (_, { location }) => location,
        closeNewScene: () => null,
        submitNewSceneSuccess: () => null,
      },
    ],
    aiSceneFormLocation: [
      null as string | null,
      {
        openAiScene: (_, { location }) => location,
        closeAiScene: () => null,
      },
    ],
    showingSettings: [
      {} as Record<string, boolean>,
      {
        toggleSettings: (state, { sceneId }) => ({ ...state, [sceneId]: !state[sceneId] }),
      },
    ],
    expandedScenes: [
      {} as Record<string, boolean>,
      {
        expandScene: (state, { sceneId }) => ({ ...state, [sceneId]: !state[sceneId] }),
      },
    ],
    activeSettingsKey: [
      null as string | null,
      {
        setActiveSettingsKey: (_, { activeSettingsKey }) => activeSettingsKey,
      },
    ],
    multiSelectEnabled: [
      false,
      {
        enableMultiSelect: () => true,
        disableMultiSelect: () => false,
      },
    ],
    isUploadingImage: [
      false,
      {
        uploadImage: () => true,
        uploadImageSuccess: () => false,
        uploadImageFailure: () => false,
      },
    ],
    previewingSceneId: [
      null as string | null,
      {
        previewScene: (_, { sceneId }) => sceneId,
        previewSceneSuccess: () => null,
        previewSceneFailure: () => null,
      },
    ],
    focusedSceneId: [
      null as string | null,
      {
        focusScene: (_, { sceneId }) => sceneId,
        clearFocusedScene: () => null,
      },
    ],
    aiPrompt: [
      '',
      {
        setAiPrompt: (_, { prompt }) => prompt,
        closeAiScene: () => '',
      },
    ],
    aiError: [
      null as string | null,
      {
        generateAiScene: () => null,
        generateAiSceneFailure: (_, { error }) => error,
        closeAiScene: () => null,
      },
    ],
    aiSceneRequestId: [
      null as string | null,
      {
        setAiSceneRequestId: (_, { requestId }) => requestId,
        closeAiScene: () => null,
      },
    ],
    aiSceneLogsByRequestId: [
      {} as Record<string, { message: string; status?: string; stage?: string; timestamp: string }[]>,
      {
        setAiSceneLogMessage: (state, { log }) => ({
          ...state,
          [log.requestId]: [...(state[log.requestId] ?? []), log],
        }),
        [socketLogic.actionTypes.aiSceneLog]: (state, { log }) => {
          if (!log.requestId) {
            return state
          }
          return {
            ...state,
            [log.requestId]: [...(state[log.requestId] ?? []), log],
          }
        },
      },
    ],
    aiSceneLogsExpanded: [
      false,
      {
        toggleAiSceneLogsExpanded: (state) => !state,
        setAiSceneLogsExpanded: (_, { expanded }) => expanded,
        closeAiScene: () => false,
      },
    ],
    isGeneratingAiScene: [
      false,
      {
        generateAiScene: () => true,
        generateAiSceneSuccess: () => false,
        generateAiSceneFailure: () => false,
      },
    ],
    isInstallingMissingActiveScene: [
      false,
      {
        installMissingActiveScene: () => true,
        installMissingActiveSceneSuccess: () => false,
        installMissingActiveSceneFailure: () => false,
      },
    ],
    missingActiveExpanded: [
      false,
      {
        toggleMissingActiveExpanded: (state) => !state,
      },
    ],
    selectedSceneIds: [
      new Set<string>(),
      {
        toggleSceneSelection: (state, { sceneId }) => {
          const next = new Set(state)
          if (next.has(sceneId)) {
            next.delete(sceneId)
          } else {
            next.add(sceneId)
          }
          return next
        },
        clearSceneSelection: () => new Set<string>(),
        setSelectedSceneIds: (_, { sceneIds }) => new Set(sceneIds),
        disableMultiSelect: () => new Set<string>(),
        deleteScene: (state, { sceneId }) => {
          const next = new Set(state)
          next.delete(sceneId)
          return next
        },
      },
    ],
  }),
  selectors({
    frameId: [() => [(_, props: ScenesLogicProps) => props.frameId], (frameId) => frameId],
    editingFrame: [(s) => [s.frameForm, s.frame], (frameForm, frame) => frameForm || frame || null],
    rawScenes: [(s) => [s.editingFrame], (frame): FrameScene[] => frame.scenes ?? []],
    undeployedSceneIds: [
      (s) => [s.rawScenes, s.frame],
      (scenes, frame): Set<string> => {
        const deployedScenes: FrameScene[] = frame?.last_successful_deploy?.scenes ?? []
        const undeployed = new Set<string>()

        scenes.forEach((scene) => {
          const deployed = deployedScenes.find((deployedScene) => deployedScene.id === scene.id)
          if (!deployed || !equal(scene, deployed)) {
            undeployed.add(scene.id)
          }
        })

        return undeployed
      },
    ],
    unsavedSceneIds: [
      (s) => [s.frame, s.frameForm],
      (frame, frameForm): Set<string> => {
        const frameScenes = frame.scenes || []
        const unsavedScenes = frameForm?.scenes || frame.scenes || []
        const unsaved = new Set<string>()
        unsavedScenes.forEach((scene) => {
          const original = frameScenes.find((s) => s.id === scene.id)
          if (!original || !equal(original, scene)) {
            unsaved.add(scene.id)
          }
        })
        return unsaved
      },
    ],
    scenes: [
      (s) => [s.rawScenes, s.unsavedSceneIds, s.undeployedSceneIds],
      (rawScenes, unsavedSceneIds, undeployedSceneIds) => {
        return rawScenes.toSorted((a, b) => {
          const aPriority = unsavedSceneIds.has(a.id) || undeployedSceneIds.has(a.id)
          const bPriority = unsavedSceneIds.has(b.id) || undeployedSceneIds.has(b.id)
          if (aPriority !== bPriority) {
            return aPriority ? -1 : 1
          }
          return a.name.localeCompare(b.name)
        })
      },
    ],
    filteredScenes: [
      (s) => [s.scenes, s.search],
      (scenes, search) => {
        const searchPieces = search
          .toLowerCase()
          .split(' ')
          .filter((s) => s)
        if (searchPieces.length === 0) {
          return scenes
        }
        return scenes.filter((scene) => searchPieces.every((piece) => scene.name.toLowerCase().includes(piece)))
      },
    ],
    sceneTitles: [(s) => [s.scenes], (scenes) => Object.fromEntries(scenes.map((scene) => [scene.id, scene.name]))],
    linksToOtherScenes: [
      (s) => [s.scenes],
      (scenes): Record<string, Set<string>> => {
        return Object.fromEntries(
          scenes.map((scene) => [
            scene.id,
            new Set<string>(
              scene.nodes
                .filter((node) => node.type === 'scene')
                .map((node) => (node.data as SceneNodeData)?.keyword)
                .filter(Boolean)
            ),
          ])
        )
      },
    ],
    otherScenesLinkingToScene: [
      (s) => [s.linksToOtherScenes],
      (links): Record<string, Set<string>> => {
        const result: Record<string, Set<string>> = {}
        Object.entries(links).forEach(([sceneId, linkedScenes]) => {
          linkedScenes.forEach((linkedScene) => {
            result[linkedScene] ||= new Set()
            result[linkedScene].add(sceneId)
          })
        })
        return result
      },
    ],
    sceneSecretSettings: [
      (s) => [s.scenes, s.apps],
      (scenes, apps): Map<string, string[]> => {
        const settingsByScene = new Map<string, string[]>()
        for (const scene of scenes) {
          const secretSettings = collectSecretSettingsFromScenes([scene], apps)
          if (secretSettings.length) {
            settingsByScene.set(scene.id, secretSettings)
          }
        }
        return settingsByScene
      },
    ],
    linkedActiveSceneId: [
      (s) => [s.activeSceneId, s.scenes],
      (activeSceneId, scenes) => {
        if (!activeSceneId) {
          return null
        }
        if (!activeSceneId.startsWith(UPLOADED_SCENE_PREFIX)) {
          return activeSceneId
        }
        const candidateId = activeSceneId.slice(UPLOADED_SCENE_PREFIX.length)
        return scenes.some((scene) => scene.id === candidateId) ? candidateId : activeSceneId
      },
    ],
    activeScene: [
      (s) => [s.scenes, s.linkedActiveSceneId],
      (scenes, linkedActiveSceneId) => scenes.find((scene) => scene.id === linkedActiveSceneId) ?? null,
    ],
    missingActiveSceneId: [
      (s) => [s.activeScene, s.activeSceneId],
      (activeScene, activeSceneId) => (!activeScene && activeSceneId ? activeSceneId : null),
    ],
    activeUploadedScene: [
      (s) => [s.missingActiveSceneId, s.uploadedScenes],
      (missingActiveSceneId, uploadedScenes) =>
        missingActiveSceneId
          ? uploadedScenes.find((scene) => `uploaded/${scene.id}` === missingActiveSceneId) ?? null
          : null,
    ],
    missingActiveMatchesSearch: [
      (s) => [s.search, s.missingActiveSceneId, s.activeUploadedScene],
      (search, missingActiveSceneId, activeUploadedScene) => {
        if (!missingActiveSceneId) {
          return false
        }
        const searchPieces = search
          .toLowerCase()
          .split(' ')
          .filter((s) => s)
        if (searchPieces.length === 0) {
          return true
        }
        const sceneName = activeUploadedScene?.name?.toLowerCase() ?? ''
        if (!sceneName) {
          return false
        }
        return searchPieces.every((piece) => sceneName.includes(piece))
      },
    ],
    aiSceneLastLog: [
      (s) => [s.aiSceneRequestId, s.aiSceneLogsByRequestId],
      (requestId, logsByRequestId) => {
        if (!requestId) {
          return null
        }
        const logs = logsByRequestId[requestId] ?? []
        return logs.length ? logs[logs.length - 1] : null
      },
    ],
    aiSceneLogs: [
      (s) => [s.aiSceneRequestId, s.aiSceneLogsByRequestId],
      (requestId, logsByRequestId) =>
        requestId
          ? [...(logsByRequestId[requestId] ?? [])].toSorted(
              (left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime()
            )
          : [],
    ],
  }),
  listeners(({ actions, cache, props }) => ({
    focusScene: ({ sceneId }) => {
      if (!sceneId) {
        return
      }
      if (cache.focusedSceneTimeout) {
        clearTimeout(cache.focusedSceneTimeout)
      }
      cache.focusedSceneTimeout = window.setTimeout(() => {
        actions.clearFocusedScene()
        cache.focusedSceneTimeout = null
      }, 2500)
    },
    generateAiScene: async () => {
      const prompt = values.aiPrompt.trim()
      if (!prompt) {
        actions.generateAiSceneFailure('Add a prompt to generate a scene.')
        return
      }
      const requestId = uuidv4()
      actions.setAiSceneRequestId(requestId)
      actions.setAiSceneLogsExpanded(true)
      try {
        const response = await apiFetch('/api/ai/scenes/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, requestId, frameId: props.frameId }),
        })
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}))
          throw new Error(payload?.detail || 'Failed to generate scene')
        }
        const payload = await response.json()
        const scenes = Array.isArray(payload?.scenes) ? payload.scenes : []
        const title = typeof payload?.title === 'string' ? payload.title : undefined
        if (!scenes.length) {
          throw new Error('No scenes returned from AI')
        }
        const existingSceneIds = new Set(values.scenes.map((scene) => scene.id))
        const sanitizedScenes = scenes.map((scene: Partial<FrameScene>) => {
          const sanitizedScene = sanitizeScene(scene, values.frameForm)
          return {
            ...sanitizedScene,
            settings: {
              ...sanitizedScene.settings,
              autoArrangeOnLoad: true,
            },
          }
        })
        actions.applyTemplate({ scenes: sanitizedScenes, name: title || 'AI Generated Scene' })
        actions.generateAiSceneSuccess()
        await new Promise((resolve) => setTimeout(resolve, 0))
        const updatedScenes = values.frameForm?.scenes ?? values.scenes
        const newlyAddedScene = updatedScenes.find((scene) => !existingSceneIds.has(scene.id))
        if (newlyAddedScene) {
          actions.focusScene(newlyAddedScene.id)
        }
        actions.setAiSceneLogMessage({
          requestId,
          message: 'Scene generated: ' + (title || 'AI Generated Scene'),
          status: 'success',
          timestamp: new Date().toISOString(),
        })
      } catch (error) {
        console.error(error)
        actions.generateAiSceneFailure(error instanceof Error ? error.message : 'Failed to generate scene')
        actions.setAiSceneLogMessage({
          requestId,
          message: error instanceof Error ? error.message : 'Failed to generate scene',
          status: 'error',
          timestamp: new Date().toISOString(),
        })
      }
    },
    uploadImage: async ({ file }) => {
      try {
        const formData = new FormData()
        formData.append('file', file)
        const response = await apiFetch(`/api/frames/${props.frameId}/assets/upload_image`, {
          method: 'POST',
          body: formData,
        })
        if (!response.ok) {
          throw new Error('Image upload failed')
        }
        const payload = await response.json()
        const assetsPath = values.frameForm.assets_path || '/srv/assets'
        const relativePath = payload?.path || ''
        const filename = payload?.filename || relativePath.split('/').pop() || file.name
        const sceneId = uuidv4()
        const scene = buildSdCardImageScene(filename, assetsPath, sceneId)
        await actions.sendEvent('uploadScenes', { scenes: [scene], sceneId })
        actions.uploadImageSuccess()
      } catch (error) {
        console.error(error)
        alert('Failed to upload image')
        actions.uploadImageFailure()
      }
    },
    previewScene: async ({ sceneId, state }) => {
      const scene = values.scenes.find((item) => item.id === sceneId)
      if (!scene) {
        actions.previewSceneFailure()
        return
      }
      try {
        const resolvedState = state ?? values.states?.[scene.id] ?? values.states?.[`uploaded/${scene.id}`] ?? null
        const payloadScene = applyStateToSceneFields(scene, resolvedState)
        const payload = {
          scenes: [payloadScene],
          sceneId: scene.id,
          ...(resolvedState && Object.keys(resolvedState).length > 0 ? { state: resolvedState } : {}),
        }
        await actions.sendEvent('uploadScenes', payload)
        actions.previewSceneSuccess()
      } catch (error) {
        console.error(error)
        alert('Failed to preview the scene')
        actions.previewSceneFailure()
      }
    },
    installMissingActiveScene: async () => {
      if (!values.uploadedScenes.length) {
        actions.installMissingActiveSceneFailure()
        return
      }
      try {
        const currentState =
          values.missingActiveSceneId && values.states ? values.states[values.missingActiveSceneId] : null
        const uploadedScenes = values.uploadedScenes.map((scene) => {
          if (!values.activeUploadedScene || scene.id !== values.activeUploadedScene.id) {
            return scene
          }
          if (!currentState || !scene.fields?.length) {
            return scene
          }
          const fields = scene.fields.map((field) => {
            if (!field?.name) {
              return field
            }
            if (Object.prototype.hasOwnProperty.call(currentState, field.name)) {
              return { ...field, value: String(currentState[field.name]) }
            }
            return field
          })
          return { ...scene, fields }
        })

        let imageBlob: Blob | null = null
        try {
          const tokenResponse = await apiFetch(`/api/frames/${props.frameId}/image_token`)
          if (tokenResponse.ok) {
            const tokenPayload = await tokenResponse.json()
            const token = encodeURIComponent(tokenPayload.token)
            const imageResponse = await apiFetch(`/api/frames/${props.frameId}/image?token=${token}`)
            if (imageResponse.ok) {
              imageBlob = await imageResponse.blob()
            }
          }
        } catch (error) {
          console.error('Failed to fetch current frame image', error)
        }

        actions.applyTemplate({
          scenes: uploadedScenes,
          name: values.activeUploadedScene?.name || 'Active scene',
          image: imageBlob ?? undefined,
        })
        actions.installMissingActiveSceneSuccess()
      } catch (error) {
        console.error('Failed to install uploaded scenes', error)
        alert('Failed to install the active scene')
        actions.installMissingActiveSceneFailure()
      }
    },
    setAsDefault: ({ sceneId }) => {
      frameLogic({ frameId: props.frameId }).actions.setFrameFormValues({
        scenes: values.scenes.map((s) =>
          s.id === sceneId ? { ...s, default: true } : s['default'] ? { ...s, default: false } : s
        ),
      })
    },
    removeDefault: () => {
      frameLogic({ frameId: props.frameId }).actions.setFrameFormValues({
        scenes: values.scenes.map((scene) => {
          if ('default' in scene) {
            const { default: _, ...rest } = scene
            return rest
          }
          return scene
        }),
      })
    },
    duplicateScene: ({ sceneId }) => {
      const scene = values.scenes.find((s) => s.id === sceneId)
      if (!scene) {
        return
      }
      frameLogic({ frameId: props.frameId }).actions.setFrameFormValues({
        scenes: [...values.scenes, { ...scene, default: false, id: uuidv4() }],
      })
    },
    renameScene: ({ sceneId }) => {
      const sceneName = window.prompt('New name', values.scenes.find((s) => s.id === sceneId)?.name)
      if (!sceneName) {
        return
      }
      frameLogic({ frameId: props.frameId }).actions.setFrameFormValues({
        scenes: values.scenes.map((s) => (s.id === sceneId ? { ...s, name: sceneName } : s)),
      })
    },
    deleteScene: ({ sceneId }) => {
      frameLogic({ frameId: props.frameId }).actions.setFrameFormValues({
        scenes: values.scenes.filter((s) => s.id !== sceneId),
      })
      actions.closePanel({ panel: Panel.Diagram, key: sceneId })
    },
    deleteSelectedScenes: () => {
      const selectedIds = Array.from(values.selectedSceneIds)
      if (selectedIds.length === 0) {
        return
      }
      frameLogic({ frameId: props.frameId }).actions.setFrameFormValues({
        scenes: values.scenes.filter((scene) => !values.selectedSceneIds.has(scene.id)),
      })
      selectedIds.forEach((sceneId) => {
        actions.closePanel({ panel: Panel.Diagram, key: sceneId })
      })
      actions.clearSceneSelection()
    },
    closeNewScene: () => {
      actions.resetNewScene({ name: '' })
    },
    openNewScene: () => {
      actions.resetNewScene({ name: '' })
      actions.closeAiScene()
    },
    openAiScene: () => {
      actions.closeNewScene()
    },
    createNewScene: () => {
      const scenes: FrameScene[] = values.frameForm.scenes || []
      const id = uuidv4()
      frameLogic({ frameId: props.frameId }).actions.setFrameFormValues({
        scenes: [
          ...scenes,
          {
            id,
            name: 'My Scene',
            nodes: [
              {
                id: '463556ab-e4fe-40c7-93f3-40bc723f454e',
                type: 'event',
                position: {
                  x: 121,
                  y: 113,
                },
                data: {
                  keyword: 'render',
                },
                width: 99,
                height: 40,
              },
            ],
            edges: [],
            fields: [],
          },
        ],
      })
      actions.editScene(id)
      actions.resetNewScene()
    },
    copySceneJSON: ({ sceneId }) => {
      const scene = values.scenes.find((s) => s.id === sceneId)
      if (!scene) {
        return
      }
      navigator.clipboard.writeText(JSON.stringify(scene))
    },
  })),
  afterMount(({ actions }) => {
    actions.syncActiveScene()
  }),
])
