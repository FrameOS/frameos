import type { TemplateType } from '../types'

// Pure: the store pages' sort, kept apart from storeCatalog.ts so a test of it
// does not drag the templates logic (and the whole SPA) into the cloud typecheck.

/**
 * How a store page orders the scenes on a shelf. `newest` (the default) is by
 * when each scene was added, so a new scene is not buried under the oldest
 * ones' installs; `popular` is the index's own order (featured scenes first,
 * then by install count, then latest change); `latest` is by the scene's last
 * change; `name` is alphabetical.
 */
export type StoreSort = 'newest' | 'popular' | 'latest' | 'name'

export const STORE_SORT_OPTIONS: { value: StoreSort; label: string }[] = [
  { value: 'newest', label: 'Newest' },
  { value: 'popular', label: 'Most installed' },
  { value: 'latest', label: 'Recently updated' },
  { value: 'name', label: 'A to Z' },
]

export function storeSortOf(value: unknown): StoreSort {
  return value === 'popular' || value === 'latest' || value === 'name' ? value : 'newest'
}

export function sortStoreTemplates(templates: TemplateType[], sort: StoreSort): TemplateType[] {
  if (sort === 'popular') {
    return templates
  }
  if (sort === 'newest') {
    return latestStoreAdditions(templates)
  }
  const name = (template: TemplateType): string => String(template.name ?? '')
  const updated = (template: TemplateType): string => String(template.updated ?? '')
  return [...templates].sort((a, b) =>
    sort === 'name'
      ? name(a).localeCompare(name(b), undefined, { sensitivity: 'base' })
      : // Newest first; an entry without a date sorts last, ties keep the index order.
        updated(b).localeCompare(updated(a))
  )
}

/**
 * The store's latest additions (the frames home): newest first by when each
 * scene was added (the index's `created`), not by its last change, which put
 * every scene that got a new version back at the front. An index cached
 * before it carried `created` falls back to `updated`; a scene with neither
 * sorts last, in the index's own order.
 */
export function latestStoreAdditions(templates: TemplateType[]): TemplateType[] {
  return templates
    .map((template, index) => {
      const stamp = template.created ?? template.updated
      return { template, index, at: stamp ? Date.parse(stamp) : NaN }
    })
    .sort((a, b) => {
      if (Number.isNaN(a.at) !== Number.isNaN(b.at)) {
        return Number.isNaN(a.at) ? 1 : -1
      }
      return (Number.isNaN(b.at) ? 0 : b.at) - (Number.isNaN(a.at) ? 0 : a.at) || a.index - b.index
    })
    .map(({ template }) => template)
}
