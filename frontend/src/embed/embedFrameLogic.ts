import { actions, kea, key, listeners, path, props, reducers, selectors } from 'kea'
import { forms } from 'kea-forms'
import { FrameScene, FrameType } from '../types'
import { frameFormSceneErrors } from '../scenes/frame/frameFormSceneErrors'
import type { embedFrameLogicType } from './embedFrameLogicType'

// In-memory replacement for frameLogic's editor-facing slice, used by the
// standalone embedded editor build (see frameLogicShim.ts and build.mjs).
// Scenes come in over postMessage and edits flow back out through
// embedBridge — there is no backend and nothing to deploy.
//
// frameForm is a real kea-forms form (like the one on the real frameLogic):
// the settings/state/events panels render <Form logic={frameLogic}
// formKey="frameForm"> fields, and logics like scenesLogic connect to
// form-generated actions such as submitFrameFormSuccess.

export interface EmbedFrameLogicProps {
  frameId: number
}

export const embedBridge: {
  onScenesChanged?: (scenes: FrameScene[]) => void
} = {}

export const embedFrameLogic = kea<embedFrameLogicType>([
  path(['src', 'embed', 'embedFrameLogic']),
  props({} as EmbedFrameLogicProps),
  key((props: EmbedFrameLogicProps) => props.frameId),
  actions({
    initEmbedFrame: (frame: Partial<FrameType>) => ({ frame }),
    applyTemplate: (template: any, openDrawer?: boolean) => ({ template, openDrawer }),
    sendEvent: (event: string, payload?: Record<string, any>) => ({ event, payload }),
    updateScene: (sceneId: string, scene: Partial<FrameScene>) => ({ sceneId, scene }),
    updateNodeData: (sceneId: string, nodeId: string, nodeData: Record<string, any>) => ({
      sceneId,
      nodeId,
      nodeData,
    }),
  }),
  forms(() => ({
    frameForm: {
      options: {
        showErrorsOnTouch: true,
      },
      defaults: {} as FrameType,
      errors: (state: Partial<FrameType>) => ({
        scenes: frameFormSceneErrors(state.scenes),
      }),
      // Nothing to save: edits already stream out through embedBridge.
      submit: async () => {},
    },
  })),
  reducers({
    frame: [
      null as Partial<FrameType> | null,
      {
        initEmbedFrame: (_: any, { frame }: { frame: Partial<FrameType> }) => frame,
      },
    ],
    frameForm: {
      initEmbedFrame: (_: any, { frame }: { frame: Partial<FrameType> }) => ({ ...frame } as FrameType),
    },
  }),
  selectors({
    frameId: [() => [(_: any, props: EmbedFrameLogicProps) => props.frameId], (frameId: number) => frameId],
    scenes: [
      (s: any) => [s.frame, s.frameForm],
      (frame: Partial<FrameType> | null, frameForm: Partial<FrameType>): FrameScene[] =>
        frameForm?.scenes ?? frame?.scenes ?? [],
    ],
    mode: [
      (s: any) => [s.frame, s.frameForm],
      (frame: Partial<FrameType> | null, frameForm: Partial<FrameType>) => frameForm?.mode || frame?.mode || 'rpios',
    ],
    width: [
      (s: any) => [s.frameForm],
      (frameForm: Partial<FrameType>) =>
        frameForm.rotate === 90 || frameForm.rotate === 270 ? frameForm.height : frameForm.width,
    ],
    height: [
      (s: any) => [s.frameForm],
      (frameForm: Partial<FrameType>) =>
        frameForm.rotate === 90 || frameForm.rotate === 270 ? frameForm.width : frameForm.height,
    ],
    defaultInterval: [(s: any) => [s.frameForm], (frameForm: Partial<FrameType>) => frameForm.interval ?? 300],
    defaultScene: [
      (s: any) => [s.scenes],
      (scenes: FrameScene[]) =>
        (scenes.find((scene) => scene.id === 'default' || scene.default) || scenes[0])?.id ?? null,
    ],
    unsavedChanges: [() => [], () => false],
    // No deploys and no frame-admin mode in the embed; connected logics
    // (scenesLogic and friends) still expect these to exist.
    lastDeploy: [() => [], () => null],
    isFrameAdminMode: [() => [], () => false],
  }),
  listeners(({ actions, values }: { actions: any; values: any }) => ({
    setFrameFormValues: async (_: any, breakpoint: any) => {
      await breakpoint(150)
      embedBridge.onScenesChanged?.(values.frameForm?.scenes ?? [])
    },
    // Individual form-field edits (kea-forms Field components dispatch
    // setFrameFormValue) must stream out the same way batched edits do.
    setFrameFormValue: async (_: any, breakpoint: any) => {
      await breakpoint(150)
      embedBridge.onScenesChanged?.(values.frameForm?.scenes ?? [])
    },
    sendEvent: () => {
      // No frame to send events to in the embed.
    },
    updateScene: ({ sceneId, scene }: { sceneId: string; scene: Partial<FrameScene> }) => {
      const frameForm = values.frameForm
      const hasScene = frameForm.scenes?.some(({ id }: FrameScene) => id === sceneId)
      const scenes = hasScene
        ? frameForm.scenes?.map((s: FrameScene) => (s.id === sceneId ? { ...s, ...scene } : s))
        : [...(frameForm.scenes ?? []), { ...scene, id: sceneId } as FrameScene]
      actions.setFrameFormValues({ scenes })
    },
    updateNodeData: ({
      sceneId,
      nodeId,
      nodeData,
    }: {
      sceneId: string
      nodeId: string
      nodeData: Record<string, any>
    }) => {
      const scenes: FrameScene[] = values.frameForm.scenes ?? values.frame?.scenes ?? []
      const scene = scenes.find(({ id }) => id === sceneId)
      const currentNode = scene?.nodes?.find(({ id }) => id === nodeId)
      if (currentNode) {
        actions.setFrameFormValues({
          scenes: scenes.map((s) =>
            s.id === sceneId
              ? {
                  ...s,
                  nodes: s.nodes?.map((n) =>
                    n.id === nodeId ? { ...n, data: { ...(n.data ?? {}), ...nodeData } } : n
                  ),
                }
              : s
          ),
        })
      } else {
        console.error(`Node ${nodeId} not found in scene ${sceneId}`)
      }
    },
    applyTemplate: ({ template }: { template: any }) => {
      // The embedded editor has no template store; adding a template means
      // appending its scenes.
      const incoming: FrameScene[] = template?.scenes ?? []
      if (incoming.length > 0) {
        actions.setFrameFormValues({ scenes: [...(values.frameForm.scenes ?? []), ...incoming] })
      }
    },
  })),
])
