import { actions, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'

import { frameLogic } from '../../frameLogic'

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
    values: [frameLogic({ frameId }), ['frame', 'frameForm', 'frameFormErrors']],
    actions: [frameLogic({ frameId }), ['updateScene']],
  })),
  actions({
    setFields: (fields: StateField[]) => ({ fields }),
    editField: (index: number) => ({ index }),
    closeField: (index: number) => ({ index }),
    removeField: (index: number) => ({ index }),
    addField: true,
    createField: (stateField: StateField) => ({ stateField }),
  }),
  reducers({
    editingFields: [
      {} as Record<string, boolean>,
      {
        editField: (state, { index }) => ({ ...state, [index]: true }),
        closeField: (state, { index }) => ({ ...state, [index]: false }),
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
    scenes: [(s) => [s.frame, s.frameForm], (frame, frameForm) => frameForm.scenes ?? frame.scenes ?? []],
    scene: [
      (s, p) => [s.scenes, p.sceneId],
      (scenes, sceneId): FrameScene | null => scenes?.find((scene) => scene.id === sceneId) ?? null,
    ],
    sceneIndex: [
      (s, p) => [s.scenes, p.sceneId],
      (scenes, sceneId): number => scenes?.findIndex((scene) => scene.id === sceneId) ?? 0,
    ],
  }),
  selectors({
    fieldsWithErrors: [
      (s) => [s.frameFormErrors, s.sceneIndex, s.scene],
      (frameFormErrors: Record<string, any>, sceneIndex: number, scene: FrameScene | null): Record<string, boolean> => {
        const errors = frameFormErrors.scenes?.[sceneIndex] ?? {}
        const fields = scene?.fields ?? []
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
    setFields: ({ fields }) => {
      if (props.sceneId) {
        actions.updateScene(props.sceneId, { fields })
      }
    },
    removeField({ index }) {
      const sceneFields = values.scene?.fields ?? []
      const newFields = sceneFields.map((f, i) => (i === index ? undefined : f)).filter(Boolean) as StateField[]
      actions.setFields(newFields)
    },
    addField: () => {
      const oldFields = values.scene?.fields ?? []
      actions.setFields([...oldFields, { name: '', label: '', type: 'string', persist: 'disk', access: 'public' }])
      actions.editField(oldFields.length)
    },
    createField: ({ stateField }) => {
      const oldFields = values.scene?.fields ?? []
      actions.setFields([...oldFields, stateField])
    },
  })),
])
