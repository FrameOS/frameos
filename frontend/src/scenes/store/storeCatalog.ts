import type { RepositoryType, TemplateType } from '../../types'
import { isCloudMode } from '../../utils/cloudMode'
import { isCloudStoreRepository } from '../frame/panels/Templates/templatesLogic'

export * from './storeShelves'

export { STORE_SORT_OPTIONS, sortStoreTemplates, storeSortOf, type StoreSort } from '../../utils/storeSort'

// The store catalog as the SPA shows it: pure functions over the
// repositories a plane tracks, shared by the signed-in library
// (scenesLibraryLogic) and the signed-out store front (publicStoreLogic).

/** The cloud store's scenes, whichever row(s) track it; one entry per
 * store scene even when a backend tracks the store twice. */
export function storeTemplatesOf(repositories: RepositoryType[]): TemplateType[] {
  const seen = new Set<string>()
  const templates: TemplateType[] = []
  for (const repository of repositories.filter(isCloudStoreRepository)) {
    for (const template of repository.templates ?? []) {
      const key = template.sceneId ?? template.id ?? template.url ?? template.name
      if (key && seen.has(key)) {
        continue
      }
      if (key) {
        seen.add(key)
      }
      templates.push(template)
    }
  }
  return templates
}

/**
 * The store rows a backend tracks (the seeded `{provider}/api/store/...` row).
 * Its listing refreshes them only once a day, so the store page's Refresh
 * asks for each one by id. The cloud and the frame read the store directly
 * (their rows are `system-`) and just reload.
 */
export function trackedStoreRepositoryIds(repositories: RepositoryType[]): string[] {
  return repositories
    .filter(isCloudStoreRepository)
    .map((repository) => repository.id)
    .filter((id): id is string => !!id && !id.startsWith('system-'))
}

/** Where the store's own pages live (each template's `url` is a scene page
 * there): a self-hosted provider's host, or scenes.frameos.net. */
export function storeOriginOf(storeTemplates: TemplateType[]): string {
  for (const template of storeTemplates) {
    if (typeof template.url === 'string' && /^https?:\/\//.test(template.url)) {
      try {
        return new URL(template.url).origin
      } catch {
        // fall through to the default
      }
    }
  }
  return isCloudMode() && typeof window !== 'undefined' ? window.location.origin : 'https://scenes.frameos.net'
}

/** The catalog row a store template came from (for an install). */
export function storeRepositoryOf(repositories: RepositoryType[], template: TemplateType): RepositoryType | null {
  return (
    repositories
      .filter(isCloudStoreRepository)
      .find((repository) =>
        (repository.templates ?? []).some(
          (candidate) =>
            (template.sceneId && candidate.sceneId === template.sceneId) ||
            (template.id && candidate.id === template.id)
        )
      ) ?? null
  )
}
