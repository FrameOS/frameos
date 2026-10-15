import type { RepositoryType, TemplateType } from '../../types'
import { isCloudMode } from '../../utils/cloudMode'
import { searchInText } from '../../utils/searchInText'
import { groupByStoreShelf, storeShelfForCategory, type StoreCategoryShelf } from '../../utils/storeCategories'
import { isCloudStoreRepository } from '../frame/panels/Templates/templatesLogic'

// The store catalog as the SPA shows it: pure functions over the
// repositories a plane tracks, shared by the signed-in library
// (scenesLibraryLogic) and the signed-out store front (publicStoreLogic).

export interface StoreShelfGroup {
  shelf: StoreCategoryShelf
  templates: TemplateType[]
}

export interface StoreShelfCount {
  shelf: StoreCategoryShelf
  count: number
}

export interface StoreTagCount {
  tag: string
  count: number
}

export interface StoreFilters {
  search: string
  category: string | null
  tag: string | null
}

export function templateMatchesSearch(search: string, template: TemplateType): boolean {
  return (
    search === '' ||
    searchInText(search, template.name) ||
    searchInText(search, template.description) ||
    searchInText(search, template.author) ||
    (template.tags ?? []).some((tag) => searchInText(search, tag))
  )
}

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

export function storeShelfCountsOf(storeTemplates: TemplateType[]): StoreShelfCount[] {
  return groupByStoreShelf(storeTemplates).map(({ shelf, templates }) => ({ shelf, count: templates.length }))
}

/** The tags of the scenes on the page: within the category when one is
 * chosen, so the cloud and its counts describe what is listed. */
export function storeTagCountsOf(storeTemplates: TemplateType[], category: string | null = null): StoreTagCount[] {
  const counts = new Map<string, number>()
  const templates = category
    ? storeTemplates.filter((template) => storeShelfForCategory(template.category).slug === category)
    : storeTemplates
  for (const template of templates) {
    for (const tag of new Set((template.tags ?? []).map((value) => value.toLowerCase()))) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .toSorted((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}

export function storeShelvesOf(
  storeTemplates: TemplateType[],
  { search, category, tag }: StoreFilters
): StoreShelfGroup[] {
  return groupByStoreShelf(
    storeTemplates.filter(
      (template) =>
        templateMatchesSearch(search, template) &&
        (!category || storeShelfForCategory(template.category).slug === category) &&
        (!tag || (template.tags ?? []).some((value) => value.toLowerCase() === tag))
    )
  )
}
