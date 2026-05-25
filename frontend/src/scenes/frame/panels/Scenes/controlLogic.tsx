import { actions, afterMount, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'

import { frameLogic } from '../../frameLogic'

import { FrameScene, FrameStateRecord } from '../../../../types'

import { loaders } from 'kea-loaders'

import type { controlLogicType } from './controlLogicType'
import { socketLogic } from '../../../socketLogic'
import { apiFetch } from '../../../../utils/apiFetch'
import { longRunningTasksModel } from '../../../../models/longRunningTasksModel'

export interface ControlLogicProps {
  frameId: number
}

const UPLOADED_SCENE_PREFIX = 'uploaded/'
const emptyFrameStateRecord: FrameStateRecord = { sceneId: '', states: {} }

function normaliseFrameStateRecord(payload: any): FrameStateRecord {
  const sceneId = typeof payload?.sceneId === 'string' ? payload.sceneId : ''
  const states =
    payload?.states && typeof payload.states === 'object' && !Array.isArray(payload.states) ? payload.states : {}
  return {
    sceneId,
    states,
    ...(payload?.cache && typeof payload.cache === 'object' ? { cache: payload.cache } : {}),
  }
}

export const controlLogic = kea<controlLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Scenes', 'controlLogic']),
  props({} as ControlLogicProps),
  key((props) => props.frameId),
  connect(({ frameId }: ControlLogicProps) => ({
    values: [frameLogic({ frameId }), ['frame', 'frameForm']],
    actions: [frameLogic({ frameId }), ['updateScene', 'applyTemplate']],
  })),
  actions({
    sync: true,
    setCurrentScene: (sceneId: string) => ({ sceneId }),
    currentSceneChanged: (sceneId: string) => ({ sceneId }),
  }),
  loaders(({ props, values }) => ({
    stateRecord: [
      emptyFrameStateRecord,
      {
        sync: async (_, breakpoint) => {
          await breakpoint(100)

          try {
            const statesResponse = await apiFetch(`/api/frames/${props.frameId}/states`)
            if (statesResponse.ok) {
              return normaliseFrameStateRecord(await statesResponse.json())
            }
          } catch (error) {
            console.error(error)
          }

          const response = await apiFetch(`/api/frames/${props.frameId}/state`)
          if (!response.ok) {
            throw new Error('Failed to fetch frame state')
          }
          console.error('Failed to fetch frame states, but could load one state. You might need to redeploy the frame.')
          const resp = await response.json()
          return normaliseFrameStateRecord({ states: { [resp.sceneId]: resp.state }, sceneId: resp.sceneId })
        },
      },
    ],
    uploadedScenes: [
      [] as FrameScene[],
      {
        loadUploadedScenes: async () => {
          const response = await apiFetch(`/api/frames/${props.frameId}/uploaded_scenes`)
          if (!response.ok) {
            throw new Error('Failed to fetch uploaded scenes')
          }
          const payload = await response.json()
          return (payload?.scenes ?? []) as FrameScene[]
        },
      },
    ],
  })),
  reducers({
    stateRecord: [
      emptyFrameStateRecord,
      {
        currentSceneChanged: (state, { sceneId }) => ({ ...state, sceneId }),
      },
    ],
    sceneChanging: [
      null as null | string,
      {
        setCurrentScene: (_, { sceneId }) => sceneId,
        syncSuccess: () => null,
        syncFailure: () => null,
        currentSceneChanged: () => null,
      },
    ],
  }),
  selectors({
    scenes: [(s) => [s.frame, s.frameForm], (frame, frameForm) => frameForm.scenes ?? frame.scenes],
    scene: [
      (s) => [s.scenes, s.sceneId],
      (scenes, sceneId): FrameScene | null => scenes?.find((scene) => scene.id === sceneId) ?? null,
    ],
    fields: [(s) => [s.scene], (scene) => (scene?.fields ?? []).filter((field) => field.access === 'public')],
    scenesAsOptions: [
      (s) => [s.scenes],
      (scenes): { label: string; value: string }[] =>
        (scenes ?? []).map((scene) => ({
          label: scene.name || 'Unnamed Scene',
          value: scene.id || '',
        })),
    ],
    states: [(s) => [s.stateRecord], (stateRecord) => stateRecord?.states ?? {}],
    sceneId: [(s) => [s.stateRecord], (stateRecord) => stateRecord?.sceneId ?? null],
    loading: [
      (s) => [s.stateRecord, s.sceneChanging, s.stateRecordLoading],
      (stateRecord, stateRecordLoading, sceneChanging) =>
        !stateRecord?.sceneId || stateRecordLoading || !!sceneChanging,
    ],
  }),
  listeners(({ actions, props, values }) => ({
    setCurrentScene: async ({ sceneId }) => {
      const scene =
        values.frameForm.scenes?.find((item) => item.id === sceneId) ??
        values.frame?.scenes?.find((item) => item.id === sceneId)
      longRunningTasksModel.actions.startTask({
        frameId: props.frameId,
        kind: 'activate',
        sceneId,
        title: 'Activating scene',
        detail: scene?.name || sceneId,
      })
      try {
        const response = await apiFetch(`/api/frames/${props.frameId}/event/setCurrentScene`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sceneId }),
        })
        if (!response.ok) {
          throw new Error('Failed to send scene activation event')
        }
        await response.text()
      } catch (error) {
        longRunningTasksModel.actions.taskFailed({
          frameId: props.frameId,
          kind: 'activate',
          sceneId,
          detail: error instanceof Error ? error.message : 'Failed to activate scene',
        })
        throw error
      }
    },
    syncSuccess: async ({ stateRecord }, breakpoint) => {
      if (stateRecord?.sceneId?.startsWith(UPLOADED_SCENE_PREFIX)) {
        actions.loadUploadedScenes()
      }
      if (stateRecord?.cache?.refreshing) {
        const retryAfterSeconds = Math.max(1, Number(stateRecord.cache.retry_after) || 5)
        await breakpoint(retryAfterSeconds * 1000)
        actions.sync()
      }
    },
    [socketLogic.actionTypes.newLog]: ({ log }) => {
      try {
        const { event, sceneId } = JSON.parse(log.line)
        if (event === 'render:sceneChange') {
          if (sceneId !== values.sceneId) {
            actions.currentSceneChanged(sceneId)
            actions.sync()
          } else {
            actions.currentSceneChanged(sceneId)
          }
        } else if (
          event === 'event:setSceneState' ||
          event === 'event:setCurrentScene' ||
          event === 'event:uploadScenes'
        ) {
          actions.sync()
        }
      } catch (error) {}
    },
  })),
  afterMount(({ actions }) => {
    actions.sync()
  }),
])
