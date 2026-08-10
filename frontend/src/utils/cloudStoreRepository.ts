import type { RepositoryType, TemplateType } from '../types'

// FrameOS Cloud serves its scene catalogs in the frameos repository JSON
// format (cloud/apps/auth-web/src/lib/store-repository.ts and
// /api/store/account/repository.json). On a self-hosted backend those URLs
// are added as ordinary repositories and the backend downloads/caches them
// server-side; on the cloud control plane there is no backend, so the SPA
// fetches the JSON itself and adapts it here:
//
//   * "./..." asset URLs are resolved against the repository URL (the same
//     rule backend/app/models/repository.py applies server-side), so images
//     load straight from /api/store/scenes/{id}/....
//   * every template that names its store scene uuid (`sceneId`) gains a
//     `scenesUrl` pointing at that scene's scenes.json — the one loading
//     path templatesLogic can take without a backend (fetchTemplateScenes),
//     since the zip route needs server-side unzipping.
//
// Deliberately import-free beyond the type barrel: the cloud app's node test
// suite exercises it directly.

/** The store scene uuid rides along so installs can assign the scene to a cloud frame. */
export type CloudStoreTemplate = TemplateType & { sceneId?: string; zip?: string }

interface RepositoryJson {
  description?: string
  name?: string
  templates?: (Partial<CloudStoreTemplate> & Record<string, unknown>)[]
}

function resolveRepositoryUrl(repositoryUrl: string, value: string | undefined): string | undefined {
  if (!value || !value.startsWith('./')) {
    return value
  }
  return repositoryUrl.replace(/\/[^/]+$/, '') + value.slice(1)
}

/**
 * Adapt a cloud store repository listing for the shared scene picker.
 * `id` should start with "system-" so the picker treats the entry as
 * built-in (no Refresh/Remove — there is no /api/repositories to talk to).
 */
export function cloudStoreRepository(id: string, url: string, data: RepositoryJson): RepositoryType {
  return {
    id,
    name: data.name || 'FrameOS Cloud store',
    description: data.description,
    url,
    templates: (data.templates ?? []).map((template) => {
      const sceneId = typeof template.sceneId === 'string' ? template.sceneId : undefined
      return {
        ...template,
        image: resolveRepositoryUrl(url, typeof template.image === 'string' ? template.image : undefined),
        zip: resolveRepositoryUrl(url, typeof template.zip === 'string' ? template.zip : undefined),
        ...(sceneId && !template.scenesUrl && !template.scenes?.length
          ? { scenesUrl: `/api/store/scenes/${sceneId}/scenes.json` }
          : {}),
      } as CloudStoreTemplate
    }),
  }
}
