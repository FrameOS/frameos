import { actions, connect, kea, key, listeners, path, props, selectors } from 'kea'
import type { scenesLogicType } from './scenesLogicType'
import { FrameScene } from '../../../../types'
import { frameLogic } from '../../frameLogic'
import { appsModel } from '../../../../models/appsModel'
import { forms } from 'kea-forms'
import { v4 as uuidv4 } from 'uuid'
import { panelsLogic } from '../panelsLogic'
import { Option } from '../../../../components/Select'

export interface ScenesLogicProps {
  frameId: number
}

export const scenesLogic = kea<scenesLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Scenes', 'scenesLogic']),
  props({} as ScenesLogicProps),
  key((props) => props.frameId),
  connect(({ frameId }: ScenesLogicProps) => ({
    values: [frameLogic({ frameId }), ['frame', 'frameForm'], appsModel, ['apps']],
    actions: [
      frameLogic({ frameId }),
      ['setFrameFormValues', 'applyTemplate'],
      panelsLogic({ frameId }),
      ['editScene'],
    ],
  })),
  actions({
    setAsDefault: (sceneId: string) => ({ sceneId }),
    deleteScene: (sceneId: string) => ({ sceneId }),
    renameScene: (sceneId: string) => ({ sceneId }),
  }),
  forms(({ actions, values }) => ({
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
        actions.setFrameFormValues({ scenes: [...scenes, { id, name, nodes: [], edges: [], fields: [] }] })
        actions.editScene(id)
        actions.resetNewScene()
      },
    },
  })),
  selectors({
    frameId: [() => [(_, props: ScenesLogicProps) => props.frameId], (frameId) => frameId],
    editingFrame: [(s) => [s.frameForm, s.frame], (frameForm, frame) => frameForm || frame || null],
    scenes: [(s) => [s.editingFrame], (frame): FrameScene[] => frame.scenes ?? []],
    sceneTemplateOptions: [() => [], (): Option[] => [{ label: 'Blank', value: '' }]],
  }),
  listeners(({ actions, values }) => ({
    setAsDefault: ({ sceneId }) => {
      actions.setFrameFormValues({
        scenes: values.scenes.map((s) =>
          s.id === sceneId ? { ...s, default: true } : s['default'] ? { ...s, default: false } : s
        ),
      })
    },
    renameScene: ({ sceneId }) => {
      const sceneName = window.prompt('New name', values.scenes.find((s) => s.id === sceneId)?.name)
      if (!sceneName) {
        return
      }
      actions.setFrameFormValues({
        scenes: values.scenes.map((s) => (s.id === sceneId ? { ...s, name: sceneName } : s)),
      })
    },
    deleteScene: ({ sceneId }) => {
      actions.setFrameFormValues({
        scenes: values.scenes.filter((s) => s.id !== sceneId),
      })
    },
  })),
])
