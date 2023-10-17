import { actions, kea, reducers, path, key, props, connect, listeners } from 'kea'
import { forms } from 'kea-forms'

import type { templatesLogicType } from './templatesLogicType'
import { TemplateType } from '../../../../types'
import { frameLogic } from '../../frameLogic'
import { templatesModel } from '../../../../models/templatesModel'

export interface TemplateLogicProps {
  id: number
}

export const templatesLogic = kea<templatesLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Templates', 'templatesLogic']),
  props({} as TemplateLogicProps),
  key((props) => props.id),
  connect((props: TemplateLogicProps) => ({
    values: [frameLogic(props), ['frame']],
    actions: [templatesModel, ['updateTemplate']],
  })),
  actions({
    showModal: true,
    hideModal: true,
  }),
  forms(({ actions, values, props }) => ({
    newTemplate: {
      defaults: {} as TemplateType,
      submit: async (formValues) => {
        const request: TemplateType & Record<string, any> = {
          name: formValues.name,
          description: formValues.description,
          scenes: values.frame.scenes,
          config: {
            interval: values.frame.interval,
            background_color: values.frame.background_color,
            scaling_mode: values.frame.scaling_mode,
            rotate: values.frame.rotate,
          },
          from_frame_id: props.id,
        }

        const response = await fetch(`/api/templates`, {
          method: 'POST',
          body: JSON.stringify(request),
          headers: {
            'Content-Type': 'application/json',
          },
        })
        if (!response.ok) {
          throw new Error('Failed to update frame')
        }
        actions.hideModal()
        actions.resetNewTemplate()
        actions.updateTemplate(await response.json())
      },
      errors: (newTemplate) => ({
        name: !newTemplate.name ? 'Name is required' : null,
      }),
      options: {
        showErrorsOnTouch: true,
      },
    },
  })),
  reducers({
    showingModal: [
      false,
      {
        showModal: () => true,
        hideModal: () => false,
      },
    ],
    newTemplate: {
      showModal: () => ({ name: '' }),
    },
  }),
])
