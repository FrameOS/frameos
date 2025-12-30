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

export interface ScenesLogicProps {
  frameId: number
}

export const scenesLogic = kea<scenesLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Scenes', 'scenesLogic']),
  props({} as ScenesLogicProps),
  key((props) => props.frameId),
  connect(({ frameId }: ScenesLogicProps) => ({
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
    toggleNewScene: true,
    closeNewScene: true,
    createNewScene: true,
    sync: true,
    expandScene: (sceneId: string) => ({ sceneId }),
    copySceneJSON: (sceneId: string) => ({ sceneId }),
    setSearch: (search: string) => ({ search }),
    setActiveSettingsKey: (activeSettingsKey: string | null) => ({ activeSettingsKey }),
    enableMultiSelect: true,
    disableMultiSelect: true,
    clearSceneSelection: true,
    toggleSceneSelection: (sceneId: string) => ({ sceneId }),
    toggleMissingActiveExpanded: true,
    uploadImage: (file: File) => ({ file }),
    uploadImageSuccess: true,
    uploadImageFailure: true,
    installMissingActiveScene: true,
    installMissingActiveSceneSuccess: true,
    installMissingActiveSceneFailure: true,
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
    showNewSceneForm: [
      false,
      {
        toggleNewScene: (state) => !state,
        closeNewScene: () => false,
        submitNewSceneSuccess: () => false,
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
    scenes: [(s) => [s.rawScenes], (rawScenes) => rawScenes.toSorted((a, b) => a.name.localeCompare(b.name))],
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
    undeployedSceneIds: [
      (s) => [s.scenes, s.frame],
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
    activeScene: [
      (s) => [s.scenes, s.activeSceneId],
      (scenes, activeSceneId) => scenes.find((scene) => scene.id === activeSceneId) ?? null,
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
  }),
  listeners(({ actions, props, values }) => ({
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
    toggleNewScene: () => {
      actions.resetNewScene({ name: '' })
    },
    closeNewScene: () => {
      actions.resetNewScene({ name: '' })
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
