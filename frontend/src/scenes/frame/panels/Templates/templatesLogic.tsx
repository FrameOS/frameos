import { actions, kea, reducers, path, key, props, connect, listeners } from 'kea'
import { forms } from 'kea-forms'

import type { templatesLogicType } from './templatesLogicType'
import { RepositoryType, TemplateType } from '../../../../types'
import { frameLogic } from '../../frameLogic'
import { templatesModel } from '../../../../models/templatesModel'
import { repositoriesModel } from '../../../../models/repositoriesModel'

export interface TemplateLogicProps {
  id: number
}

export const templatesLogic = kea<templatesLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Templates', 'templatesLogic']),
  props({} as TemplateLogicProps),
  key((props) => props.id),
  connect((props: TemplateLogicProps) => ({
    values: [frameLogic(props), ['frame']],
    actions: [templatesModel, ['updateTemplate'], repositoriesModel, ['updateRepository']],
  })),
  actions({
    saveAsNewTemplate: true,
    editLocalTemplate: (template: TemplateType) => ({ template }),
    hideModal: true,
    applyRemoteTemplate: (repository: RepositoryType, template: TemplateType) => ({ repository, template }),
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
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request),
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
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        })
        if (!response.ok) {
          throw new Error('Failed to update frame')
        }
        actions.updateTemplate(await response.json())
        actions.resetAddTemplateUrlForm()
      },
    },
    uploadTemplateForm: {
      defaults: {
        file: null,
      } as { file: any },
      errors: (addTemplateUrlForm) => ({
        file: !addTemplateUrlForm.file ? 'File is required' : null,
      }),
      submit: async (formValues) => {
        const formData = new FormData()
        formData.append('file', formValues.file)
        const response = await fetch(`/api/templates`, {
          method: 'POST',
          body: formData,
        })
        if (!response.ok) {
          throw new Error('Failed to update frame')
        }
        actions.updateTemplate(await response.json())
        actions.resetUploadTemplateForm()
      },
    },
    addRepositoryForm: {
      defaults: {
        name: '',
        url: '',
      } as { name: string; url: string },
      errors: (formValues) => ({
        name: !formValues.name ? 'Name is required' : null,
        url: !formValues.url ? 'URL is required' : null,
      }),
      submit: async (formValues) => {
        const request = {
          name: formValues.name,
          url: formValues.url,
        }
        const response = await fetch(`/api/repositories`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        })
        if (!response.ok) {
          throw new Error('Failed to update frame')
        }
        actions.updateRepository(await response.json())
        actions.resetAddRepositoryForm()
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
  listeners(({ actions, values, props }) => ({
    applyRemoteTemplate: async ({ template, repository }) => {
      if ('zip' in template) {
        let zipPath = (template as any).zip
        if (zipPath.startsWith('./')) {
          const repositoryPath = repository.url.replace(/\/[^/]+$/, '')
          zipPath = `${repositoryPath}/${zipPath.slice(2)}`
        }
        actions.setAddTemplateUrlFormValues({ url: zipPath })
        actions.submitAddTemplateUrlForm()
      }
    },
  })),
])
