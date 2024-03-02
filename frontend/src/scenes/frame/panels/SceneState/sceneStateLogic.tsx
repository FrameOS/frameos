import { actions, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'

import { frameLogic } from '../../frameLogic'

import { forms } from 'kea-forms'
import { FrameScene, StateField } from '../../../../types'

import type { sceneStateLogicType } from './sceneStateLogicType'

export interface SceneStateLogicProps {
  frameId: number
  sceneId: string | null
}

export const sceneStateLogic = kea<sceneStateLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Scenes', 'sceneStateLogic']),
  props({} as SceneStateLogicProps),
  key((props) => `${props.frameId}-${props.sceneId}`),
  connect(({ frameId }: SceneStateLogicProps) => ({
    values: [frameLogic({ frameId }), ['frame', 'frameForm']],
    actions: [frameLogic({ frameId }), ['updateScene']],
  })),
  actions({
    resetField: (index: number) => ({ index }),
    submitField: (index: number) => ({ index }),
    editField: (index: number) => ({ index }),
    closeField: (index: number) => ({ index }),
    removeField: (index: number) => ({ index }),
  }),
  reducers({
    editingFields: [
      {} as Record<string, boolean>,
      {
        editField: (state, { index }) => ({ ...state, [index]: true }),
        closeField: (state, { index }) => ({ ...state, [index]: false }),
        resetField: (state, { index }) => ({ ...state, [index]: false }),
        submitField: (state, { index }) => ({ ...state, [index]: false }),
        removeField: (state, { index }) =>
          Object.fromEntries(
            Object.entries(state)
              .filter(([key]) => parseInt(key) === index)
              .map(([key, value]) => [parseInt(key) > index ? String(parseInt(key) - 1) : key, value])
          ),
      },
    ],
  }),
  selectors({
    scenes: [(s) => [s.frame, s.frameForm], (frame, frameForm) => frameForm.scenes ?? frame.scenes],
    scene: [
      (s, p) => [s.scenes, p.sceneId],
      (scenes, sceneId): FrameScene | null => scenes?.find((scene) => scene.id === sceneId) ?? null,
    ],
  }),
  forms(({ selectors, actions, values, props }) => ({
    sceneForm: {
      defaults: ((state: any) => {
        const def: Record<string, any> = selectors.scene(state) || {}
        return { fields: def.fields ?? [] }
      }) as any as Partial<FrameScene>,
      errors: (state: any) => ({
        fields: (state.fields ?? []).map((field: Record<string, any>) => ({
          name: field.name ? '' : 'Name is required',
          label: field.label ? '' : 'Label is required',
          type: field.type ? '' : 'Type is required',
        })),
      }),
      submit: async (formValues) => {},
    },
  })),
  selectors({
    fieldsWithErrors: [
      (s) => [s.sceneFormErrors, s.sceneForm],
      (errors: Record<string, any>, form: Partial<FrameScene>): Record<string, boolean> => {
        const fields = form.fields ?? []
        return Object.fromEntries(
          fields.map((field, index) => {
            const fieldErrors = errors.fields?.[index] ?? {}
            return [field.name, Object.values(fieldErrors).some(Boolean)]
          })
        )
      },
    ],
  }),
  listeners(({ values, actions, props }) => ({
    resetField: ({ index }) => {
      const sceneFields = values.scene?.fields ?? []
      actions.resetSceneForm({
        fields: (values.sceneForm.fields ?? [])
          .map((field, i) => (i === index ? sceneFields[index] : field))
          .filter(Boolean) as StateField[],
      })
    },
    submitField: ({ index }) => {
      const sceneFields = values.sceneForm?.fields ?? []
      if (props.sceneId) {
        actions.updateScene(props.sceneId, {
          fields: (values.sceneForm.fields ?? [])
            .map((field, i) => (index === i ? sceneFields[index] : field))
            .filter(Boolean) as StateField[],
        })
      }
    },
    removeField({ index }) {
      const sceneFields = values.sceneForm?.fields ?? []
      const newFields = sceneFields.map((f, i) => (i === index ? undefined : f)).filter(Boolean) as StateField[]
      actions.setSceneFormValue('fields', newFields)
      if (props.sceneId) {
        actions.updateScene(props.sceneId, { fields: newFields })
      }
    },
  })),
])
