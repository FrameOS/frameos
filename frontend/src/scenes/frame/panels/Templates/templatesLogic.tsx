import { actions, kea, reducers, path, key, props, connect, listeners, selectors } from 'kea'
import { forms } from 'kea-forms'

import type { templatesLogicType } from './templatesLogicType'
import { RepositoryType, TemplateForm, TemplateType } from '../../../../types'
import { frameLogic } from '../../frameLogic'
import { templatesModel } from '../../../../models/templatesModel'
import { repositoriesModel } from '../../../../models/repositoriesModel'
import { searchInText } from '../../../../utils/searchInText'

export interface TemplateLogicProps {
  frameId: number
}
export const templatesLogic = kea<templatesLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Templates', 'templatesLogic']),
  props({} as TemplateLogicProps),
  key((props) => props.frameId),
  connect((props: TemplateLogicProps) => ({
    values: [
      frameLogic(props),
      ['frameForm'],
      templatesModel,
      ['templates as allTemplates'],
      repositoriesModel,
      ['repositories as allRepositories'],
    ],
    actions: [
      templatesModel,
      ['updateTemplate'],
      repositoriesModel,
      ['updateRepository'],
      frameLogic(props),
      ['applyTemplate'],
    ],
  })),
  actions({
    saveAsTemplate: (template?: Partial<TemplateForm>) => ({ template: template ?? {} }),
    saveAsZip: (template?: Partial<TemplateForm>) => ({ template: template ?? {} }),
    editLocalTemplate: (template: TemplateType) => ({ template }),
    hideModal: true,
    saveRemoteAsLocal: (repository: RepositoryType, template: TemplateType) => ({ repository, template }),
    applyRemoteToFrame: (repository: RepositoryType, template: TemplateType, replace?: boolean) => ({
      repository,
      template,
      replace,
    }),
    showRemoteTemplate: true,
    hideRemoteTemplate: true,
    showUploadTemplate: true,
    hideUploadTemplate: true,
    showAddRepository: true,
    hideAddRepository: true,
    setSearch: (search: string) => ({ search }),
  }),
  forms(({ actions, values, props }) => ({
    templateForm: {
      defaults: {} as TemplateForm,
      errors: (templateForm) => ({
        name: !templateForm.name ? 'Name is required' : null,
      }),
      submit: async (formValues) => {
        if (formValues.id) {
          // update
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
          // create
          const target = values.modalTarget
          const request: TemplateType & Record<string, any> = {
            name: formValues.name,
            description: formValues.description,
            scenes: (values.frameForm.scenes || []).filter((scene) => formValues.exportScenes?.includes(scene.id)),
            from_frame_id: props.frameId,
            format: target === 'zip' ? 'zip' : 'json',
          }
          const response = await fetch('/api/templates', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request),
          })
          if (!response.ok) {
            throw new Error('Failed to update frame')
          }
          if (target === 'zip') {
            const blob = await response.blob()
            const url = window.URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = `${formValues.name}.zip`
            document.body.appendChild(a)
            a.click()
            window.URL.revokeObjectURL(url)
            document.body.removeChild(a)
          } else {
            actions.updateTemplate(await response.json())
          }
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
        url: '',
      } as { name: string; url: string },
      errors: (formValues) => ({
        url: !formValues.url ? 'URL is required' : null,
      }),
      submit: async (formValues) => {
        const request = {
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
    search: ['', { setSearch: (_, { search }) => search }],
    showingModal: [
      false,
      {
        saveAsZip: () => true,
        saveAsTemplate: () => true,
        editLocalTemplate: () => true,
        hideModal: () => false,
      },
    ],
    modalTarget: [
      'localTemplate' as 'localTemplate' | 'zip',
      {
        saveAsZip: () => 'zip',
        saveAsTemplate: () => 'localTemplate',
        editLocalTemplate: () => 'localTemplate',
      },
    ],
    templateForm: {
      saveAsTemplate: (_, { template }) => ({
        id: '',
        name: '',
        description: '',
        exportScenes: undefined,
        ...template,
      }),
      saveAsZip: (_, { template }) => ({ id: '', name: '', description: '', exportScenes: undefined, ...template }),
      editLocalTemplate: (_, { template }) => ({
        id: template.id,
        name: template.name,
        description: template.description,
      }),
    },
    showingUploadTemplate: [
      false,
      {
        showUploadTemplate: () => true,
        hideUploadTemplate: () => false,
        submitAddTemplateUrlFormSuccess: () => false,
      },
    ],
    showingRemoteTemplate: [
      false,
      {
        showRemoteTemplate: () => true,
        hideRemoteTemplate: () => false,
        submitUploadTemplateFormSuccess: () => false,
      },
    ],
    showingAddRepository: [
      false,
      {
        showAddRepository: () => true,
        hideAddRepository: () => false,
        submitAddRepositoryFormSuccess: () => false,
      },
    ],
  }),
  selectors({
    templates: [
      (s) => [s.allTemplates, s.search],
      (allTemplates, search) => {
        if (search !== '') {
          return allTemplates.filter((template) => searchInText(search, template.name))
        }
        return allTemplates
      },
    ],
    repositories: [
      (s) => [s.allRepositories, s.search],
      (allRepositories, search): RepositoryType[] => {
        if (search === '') {
          return allRepositories
        }
        return allRepositories
          .filter(
            (repository) =>
              searchInText(search, repository.name) ||
              repository.templates?.some((t) => searchInText(search, t.name) || searchInText(search, t.description))
          )
          .map((repository) => ({
            ...repository,
            templates: repository.templates?.filter(
              (t) => searchInText(search, t.name) || searchInText(search, t.description)
            ),
          }))
      },
    ],
    hiddenRepositories: [
      (s) => [s.allRepositories, s.repositories],
      (allRepositories, repositories) => allRepositories.length - repositories.length,
    ],
  }),
  listeners(({ actions, values, props }) => ({
    saveRemoteAsLocal: async ({ template, repository }) => {
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
    applyRemoteToFrame: async ({ template, repository, replace }) => {
      const request: Record<string, any> = {
        format: 'scenes',
      }
      if ('zip' in template) {
        let zipPath = (template as any).zip
        if (zipPath.startsWith('./')) {
          const repositoryPath = repository.url.replace(/\/[^/]+$/, '')
          zipPath = `${repositoryPath}/${zipPath.slice(2)}`
        }
        request['url'] = zipPath
      } else {
        throw new Error('Failed to load template')
      }
      const response = await fetch(`/api/templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      })
      if (!response.ok) {
        throw new Error('Failed to update frame')
      }
      const scenes = await response.json()
      actions.applyTemplate({ scenes }, replace)
    },
    saveAsTemplate: () => {
      if ((values.templateForm.exportScenes?.length ?? 0) === 0) {
        actions.setTemplateFormValues({ exportScenes: values.frameForm?.scenes?.map((s) => s.id) || [] })
      }
    },
    saveAsZip: () => {
      if ((values.templateForm.exportScenes?.length ?? 0) === 0) {
        actions.setTemplateFormValues({ exportScenes: values.frameForm?.scenes?.map((s) => s.id) || [] })
      }
    },
    showAddRepository: () => {
      actions.setAddRepositoryFormValues({ name: '', url: '' })
    },
    showRemoteTemplate: () => {
      actions.setUploadTemplateFormValues({ file: null })
    },
    showUploadTemplate: () => {
      actions.setAddTemplateUrlFormValues({ url: '' })
    },
  })),
])
