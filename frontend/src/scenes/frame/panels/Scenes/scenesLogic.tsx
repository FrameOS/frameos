import { actions, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'
import type { scenesLogicType } from './scenesLogicType'
import { FrameScene, Panel } from '../../../../types'
import { frameLogic } from '../../frameLogic'
import { appsModel } from '../../../../models/appsModel'
import { forms } from 'kea-forms'
import { v4 as uuidv4 } from 'uuid'
import { panelsLogic } from '../panelsLogic'
import { Option } from '../../../../components/Select'

import _sceneTemplates from '../../../../../schema/templates.json'
const sceneTemplates: Record<string, Record<string, any>> = _sceneTemplates

export interface ScenesLogicProps {
  frameId: number
}

export const scenesLogic = kea<scenesLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Scenes', 'scenesLogic']),
  props({} as ScenesLogicProps),
  key((props) => props.frameId),
  connect(({ frameId }: ScenesLogicProps) => ({
    values: [frameLogic({ frameId }), ['frame', 'frameForm'], appsModel, ['apps']],
    actions: [frameLogic({ frameId }), ['applyTemplate'], panelsLogic({ frameId }), ['editScene', 'closePanel']],
  })),
  actions({
    setAsDefault: (sceneId: string) => ({ sceneId }),
    deleteScene: (sceneId: string) => ({ sceneId }),
    renameScene: (sceneId: string) => ({ sceneId }),
    addNewScene: true,
    closeNewScene: true,
  }),
  forms(({ actions, values, props }) => ({
    newScene: {
      defaults: {
        name: '',
        template: Object.keys(sceneTemplates)[0],
      },
      errors: (values) => ({
        name: !values.name ? 'Name is required' : undefined,
      }),
      submit: ({ name, template }, breakpoint) => {
        const scenes: FrameScene[] = values.frameForm.scenes || []
        const id = uuidv4()
        const templateData = sceneTemplates[template] ?? {}
        frameLogic({ frameId: props.frameId }).actions.setFrameFormValues({
          scenes: [...scenes, { id, name, nodes: [], edges: [], fields: [], ...templateData }],
        })
        actions.editScene(id)
        actions.resetNewScene()
      },
    },
  })),
  selectors({
    frameId: [() => [(_, props: ScenesLogicProps) => props.frameId], (frameId) => frameId],
    editingFrame: [(s) => [s.frameForm, s.frame], (frameForm, frame) => frameForm || frame || null],
    scenes: [(s) => [s.editingFrame], (frame): FrameScene[] => frame.scenes ?? []],
    sceneTemplateOptions: [
      () => [],
      (): Option[] => Object.keys(sceneTemplates).map((key) => ({ label: key, value: key })),
    ],
  }),
  listeners(({ actions, props, values }) => ({
    setAsDefault: ({ sceneId }) => {
      frameLogic({ frameId: props.frameId }).actions.setFrameFormValues({
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
    addNewScene: () => {
      actions.resetNewScene({ name: '', template: Object.keys(sceneTemplates)[1] })
    },
    closeNewScene: () => {
      actions.resetNewScene({ name: '', template: Object.keys(sceneTemplates)[1] })
    },
  })),
  reducers({
    showNewSceneForm: [
      false,
      {
        addNewScene: () => true,
        closeNewScene: () => false,
        submitNewSceneSuccess: () => false,
      },
    ],
  }),
])
