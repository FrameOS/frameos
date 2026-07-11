import { actions, kea, reducers, path, key, props, connect, listeners, selectors } from 'kea'
import { forms } from 'kea-forms'

import type { templatesLogicType } from './templatesLogicType'
import { FrameScene, RepositoryType, TemplateForm, TemplateType } from '../../../../types'
import { frameLogic } from '../../frameLogic'
import { templatesModel } from '../../../../models/templatesModel'
import { repositoriesModel } from '../../../../models/repositoriesModel'
import { appsModel } from '../../../../models/appsModel'
import { searchInText } from '../../../../utils/searchInText'
import { apiFetch } from '../../../../utils/apiFetch'
import { settingsLogic } from '../../../settings/settingsLogic'
import { templateCompatibilityForFrame } from '../../../../utils/embeddedCompatibility'
import { templateWithSceneOrigins } from '../../../../utils/sceneOrigin'
import { templateFavouriteId, type TemplateWithFavouriteId } from './templateFavourites'
import { cloudDriveLogic } from './cloudDriveLogic'

export interface TemplateLogicProps {
  frameId: number
}

/** Repository listings only carry template metadata; fetch the scenes separately when needed. */
export async function fetchTemplateScenes(template: TemplateType): Promise<FrameScene[]> {
  if (template.scenes?.length) {
    return template.scenes
  }
  if (!template.scenesUrl) {
    throw new Error('Template has no scenes to load')
  }
  const response = await apiFetch(template.scenesUrl)
  if (!response.ok) {
    throw new Error('Failed to load template scenes')
  }
  return await response.json()
}

/** Resolve a repository template's scenes from inline data, its scenes URL, or its zip archive. */
export async function loadRepositoryTemplateScenes(
  repository: RepositoryType,
  template: TemplateType
): Promise<FrameScene[]> {
  if (template.scenes?.length || template.scenesUrl) {
    return fetchTemplateScenes(template)
  }

  const templateWithZip = template as TemplateType & { zip?: string }
  let zipPath = templateWithZip.zip
  if (!zipPath) {
    throw new Error('Failed to load template')
  }
  if (zipPath.startsWith('./')) {
    const repositoryPath = repository.url.replace(/\/[^/]+$/, '')
    zipPath = `${repositoryPath}/${zipPath.slice(2)}`
  }

  const response = await apiFetch(`/api/templates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ format: 'scenes', url: zipPath }),
  })
  if (!response.ok) {
    throw new Error('Failed to load template scenes')
  }
  return await response.json()
}

export const templatesLogic = kea<templatesLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Templates', 'templatesLogic']),
  props({} as TemplateLogicProps),
  key((props) => props.frameId),
  connect((props: TemplateLogicProps) => ({
    values: [
      frameLogic(props),
      ['frame', 'frameForm'],
      templatesModel,
      ['templates as allTemplates'],
      repositoriesModel,
      ['repositories as allRepositories'],
      appsModel,
      ['apps'],
      settingsLogic,
      ['settings'],
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
    saveAsCloudTemplate: (template?: Partial<TemplateForm>) => ({ template: template ?? {} }),
    editLocalTemplate: (template: TemplateType) => ({ template }),
    hideModal: true,
    saveRemoteAsLocal: (repository: RepositoryType, template: TemplateType) => ({ repository, template }),
    applyRemoteToFrame: (repository: RepositoryType, template: TemplateType, openDrawer?: boolean) => ({
      openDrawer: openDrawer ?? false,
      repository,
      template,
    }),
    showRemoteTemplate: true,
    hideRemoteTemplate: true,
    showUploadTemplate: true,
    hideUploadTemplate: true,
    showAddRepository: true,
    hideAddRepository: true,
    setSearch: (search: string) => ({ search }),
    addUrlToFrame: (url: string, openDrawer?: boolean) => ({ url, openDrawer: openDrawer ?? false }),
    setAddingUrlToFrame: (adding: boolean) => ({ adding }),
    toggleExpanded: (url: string) => ({ url }),
    applyFavouriteTemplatesToFrame: (openDrawer?: boolean) => ({
      openDrawer: openDrawer ?? false,
    }),
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
          const response = await apiFetch(`/api/templates/${formValues.id}`, {
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
          const exportScenes = formValues.exportScenes ?? []
          // The preview image should show one of the scenes being saved: use
          // the frame's snapshot only when the active scene is included,
          // otherwise the first selected scene's cached snapshot.
          const activeSceneId = values.frame?.active_scene_id
          const imageSceneId =
            activeSceneId && exportScenes.includes(activeSceneId) ? undefined : exportScenes[0]

          if (target === 'cloud') {
            const response = await apiFetch('/api/cloud/store/publish', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name: formValues.name,
                description: formValues.description,
                scenes: (values.frameForm.scenes || []).filter((scene) => exportScenes.includes(scene.id)),
                from_frame_id: props.frameId,
                ...(imageSceneId ? { image_scene_id: imageSceneId } : {}),
              }),
            })
            if (!response.ok) {
              let detail = `unexpected status ${response.status}`
              try {
                detail = (await response.json())?.detail ?? detail
              } catch {
                // keep fallback detail
              }
              window.alert(`Could not save to cloud drive: ${detail}`)
              throw new Error('Failed to save to cloud drive')
            }
            const payload = await response.json()
            const scene = payload?.scene
            cloudDriveLogic.findMounted()?.actions.loadDrive()
            actions.hideModal()
            actions.resetTemplateForm()
            if (
              scene?.url &&
              window.confirm(`Saved "${formValues.name}" to your cloud drive (v${scene?.version ?? '?'}). Open it?`)
            ) {
              window.open(scene.url, '_blank', 'noopener')
            }
            return
          }

          const request: TemplateType & Record<string, any> = {
            name: formValues.name,
            description: formValues.description,
            scenes: (values.frameForm.scenes || []).filter((scene) => exportScenes.includes(scene.id)),
            from_frame_id: props.frameId,
            ...(imageSceneId ? { image_scene_id: imageSceneId } : {}),
            format: target === 'zip' ? 'zip' : 'json',
          }
          const response = await apiFetch('/api/templates', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request),
          })
          if (!response.ok) {
            throw new Error('Failed to create template')
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
        const response = await apiFetch(`/api/templates`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        })
        if (!response.ok) {
          let detail = `unexpected status ${response.status}`
          try {
            detail = (await response.json())?.detail ?? detail
          } catch {
            // keep fallback detail
          }
          window.alert(`Could not add the scene: ${detail}`)
          throw new Error('Failed to add template from URL')
        }
        actions.updateTemplate(await response.json())
        actions.resetAddTemplateUrlForm()
        // A pasted URL doubles as the search value ("Add scene from URL"
        // quick action); clear it so the freshly added scene is visible.
        if (values.search === formValues.url) {
          actions.setSearch('')
        }
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
        const response = await apiFetch(`/api/templates`, {
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
        const response = await apiFetch(`/api/repositories`, {
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
    addingUrlToFrame: [false, { setAddingUrlToFrame: (_, { adding }) => adding }],
    showingModal: [
      false,
      {
        saveAsZip: () => true,
        saveAsTemplate: () => true,
        saveAsCloudTemplate: () => true,
        editLocalTemplate: () => true,
        hideModal: () => false,
      },
    ],
    modalTarget: [
      'localTemplate' as 'localTemplate' | 'zip' | 'cloud',
      {
        saveAsZip: () => 'zip',
        saveAsTemplate: () => 'localTemplate',
        saveAsCloudTemplate: () => 'cloud',
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
      saveAsCloudTemplate: (_, { template }) => ({
        id: '',
        name: '',
        description: '',
        exportScenes: undefined,
        ...template,
      }),
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
    expanded: [
      {} as Record<string, boolean>,
      { persist: true, storageKey: 'templatesLogic.expanded' },
      {
        toggleExpanded: (state, { url }) => ({ ...state, [url]: !(state[url] ?? true) }),
      },
    ],
  }),
  selectors({
    templates: [
      (s) => [s.allTemplates, s.search],
      (allTemplates, search) => {
        if (search !== '') {
          return allTemplates
            .filter((template) => searchInText(search, template.name))
            .sort((a, b) => a.name.localeCompare(b.name))
        }
        return allTemplates
      },
    ],
    repositories: [
      (s) => [s.allRepositories, s.search],
      (allRepositories, search): RepositoryType[] => {
        if (search === '') {
          return allRepositories.map((repository) => ({
            ...repository,
            templates: repository.templates?.sort((a, b) => a.name.localeCompare(b.name)),
          }))
        }
        return allRepositories
          .filter(
            (repository) =>
              searchInText(search, repository.name) ||
              repository.templates?.some((t) => searchInText(search, t.name) || searchInText(search, t.description))
          )
          .map((repository) => ({
            ...repository,
            templates: repository.templates
              ?.filter((t) => searchInText(search, t.name) || searchInText(search, t.description))
              .sort((a, b) => a.name.localeCompare(b.name)),
          }))
      },
    ],
    hiddenRepositories: [
      (s) => [s.allRepositories, s.repositories],
      (allRepositories, repositories) => allRepositories.length - repositories.length,
    ],
    isExpanded: [(s) => [s.expanded], (expanded) => (url: string) => expanded[url] ?? true],
    installedTemplatesByName: [
      (s) => [s.frameForm],
      (frameForm) => Object.fromEntries(frameForm?.scenes?.map((s) => [s.name, true]) || []),
    ],
    favouriteTemplateIds: [
      (s) => [s.settings],
      (settings): Set<string> => new Set(settings.personal?.favouriteTemplateIds ?? []),
    ],
    favouriteTemplates: [
      (s) => [s.allTemplates, s.allRepositories, s.favouriteTemplateIds, s.frame, s.frameForm, s.apps],
      (allTemplates, allRepositories, favouriteTemplateIds, frame, frameForm, apps): TemplateWithFavouriteId[] => {
        const mode = frameForm?.mode ?? frame?.mode
        const rows: TemplateWithFavouriteId[] = []
        for (const template of allTemplates) {
          const favouriteId = templateFavouriteId(template)
          if (favouriteTemplateIds.has(favouriteId)) {
            rows.push({
              compatibility: templateCompatibilityForFrame(mode, template, apps, frameForm),
              favouriteId,
              template,
            })
          }
        }
        for (const repository of allRepositories) {
          for (const template of repository.templates ?? []) {
            const favouriteId = templateFavouriteId(template, repository)
            if (favouriteTemplateIds.has(favouriteId)) {
              rows.push({
                compatibility: templateCompatibilityForFrame(mode, template, apps, frameForm),
                favouriteId,
                repository,
                template,
              })
            }
          }
        }
        return rows.toSorted((a, b) => a.template.name.localeCompare(b.template.name))
      },
    ],
    installableFavouriteTemplates: [
      (s) => [s.favouriteTemplates],
      (favouriteTemplates): TemplateWithFavouriteId[] =>
        favouriteTemplates.filter((template) => template.compatibility.supported),
    ],
  }),
  listeners(({ actions, values }) => ({
    // Install the scene(s) behind a pasted URL (template zip, or a scene page
    // with a frameos:zip meta tag) straight onto this frame — the flow behind
    // "copy this link into the Templates search box" on FrameOS Cloud.
    addUrlToFrame: async ({ url, openDrawer }) => {
      actions.setAddingUrlToFrame(true)
      try {
        const response = await apiFetch(`/api/templates`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, format: 'scenes' }),
        })
        if (!response.ok) {
          let detail = `unexpected status ${response.status}`
          try {
            detail = (await response.json())?.detail ?? detail
          } catch {
            // keep fallback detail
          }
          window.alert(`Could not add the scene: ${detail}`)
          return
        }
        const scenes = await response.json()
        if (!Array.isArray(scenes) || scenes.length === 0) {
          window.alert('No scenes found at this URL.')
          return
        }
        actions.applyTemplate({ scenes }, openDrawer)
        if (values.search === url) {
          actions.setSearch('')
        }
      } finally {
        actions.setAddingUrlToFrame(false)
      }
    },
    saveRemoteAsLocal: async ({ template, repository }) => {
      if ('zip' in template) {
        let zipPath = (template as any).zip
        if (zipPath.startsWith('./')) {
          const repositoryPath = repository.url.replace(/\/[^/]+$/, '')
          zipPath = `${repositoryPath}/${zipPath.slice(2)}`
        }
        actions.setAddTemplateUrlFormValues({ url: zipPath })
        actions.submitAddTemplateUrlForm()
        return
      }

      if (template.scenesUrl || template.scenes?.length) {
        const scenes = await fetchTemplateScenes(template)
        const response = await apiFetch(`/api/templates`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: template.name,
            description: template.description,
            scenes,
          }),
        })
        if (!response.ok) {
          throw new Error('Failed to save template')
        }
        actions.updateTemplate(await response.json())
      }
    },
    applyRemoteToFrame: async ({ template, repository, openDrawer }) => {
      const scenes = await loadRepositoryTemplateScenes(repository, template)
      actions.applyTemplate(templateWithSceneOrigins({ ...template, scenes }, repository), openDrawer)
    },
    applyFavouriteTemplatesToFrame: async ({ openDrawer }) => {
      const templates: Partial<TemplateType>[] = []
      for (const row of values.installableFavouriteTemplates) {
        if (!row.repository) {
          templates.push(row.template)
          continue
        }

        const templateWithZip = row.template as TemplateType & { zip?: string }
        if (!row.template.scenes?.length && !row.template.scenesUrl && !templateWithZip.zip) {
          continue
        }

        const scenes = await loadRepositoryTemplateScenes(row.repository, row.template)
        templates.push(templateWithSceneOrigins({ ...row.template, scenes }, row.repository))
      }

      if (templates.length) {
        actions.applyTemplate({ __templateBatch: templates } as Partial<TemplateType>, openDrawer)
      }
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
    saveAsCloudTemplate: () => {
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
