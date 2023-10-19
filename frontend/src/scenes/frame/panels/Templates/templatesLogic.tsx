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
    saveAsNewTemplate: true,
    editLocalTemplate: (template: TemplateType) => ({ template }),
    hideModal: true,
  }),
  forms(({ actions, values, props }) => ({
    templateForm: {
      defaults: {} as TemplateType,
      errors: (templateForm) => ({
        name: !templateForm.name ? 'Name is required' : null,
      }),
      submit: async (formValues) => {
        if (formValues.id) {
          const request = {
            name: formValues.name,
            description: formValues.description,
          }
          const response = await fetch(`/api/templates/${formValues.id}`, {
            method: 'PATCH',
            body: JSON.stringify(request),
            headers: {
              'Content-Type': 'application/json',
            },
          })
          if (!response.ok) {
            throw new Error('Failed to update template')
          }
          actions.updateTemplate(await response.json())
        } else {
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
          actions.updateTemplate(await response.json())
        }
        actions.hideModal()
        actions.resetTemplateForm()
      },
      options: {
        showErrorsOnTouch: true,
      },
    },
    addTemplateUrlForm: {
      defaults: {
        url: '',
      } as { url: string },
      errors: (addTemplateUrlForm) => ({
        url: !addTemplateUrlForm.url ? 'URL is required' : null,
      }),
      submit: async (formValues) => {
        const request = {
          url: formValues.url,
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
        actions.updateTemplate(await response.json())
        actions.resetAddTemplateUrlForm()
      },
    },
  })),
  reducers({
    showingModal: [
      false,
      {
        saveAsNewTemplate: () => true,
        editLocalTemplate: () => true,
        hideModal: () => false,
      },
    ],
    templateForm: {
      saveAsNewTemplate: () => ({ name: '' }),
      editLocalTemplate: (_, { template }) => ({
        id: template.id,
        name: template.name,
        description: template.description,
      }),
    },
  }),
])
