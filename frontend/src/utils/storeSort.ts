import type { TemplateType } from '../types'

// Pure: the store pages' sort, kept apart from storeCatalog.ts so a test of it
// does not drag the templates logic (and the whole SPA) into the cloud typecheck.

/**
 * How a store page orders the scenes on a shelf. `popular` is the index's own
 * order (featured scenes first, then by install count, then latest change);
 * `latest` is by the scene's last change; `name` is alphabetical.
 */
export type StoreSort = 'popular' | 'latest' | 'name'

export const STORE_SORT_OPTIONS: { value: StoreSort; label: string }[] = [
  { value: 'popular', label: 'Most installed' },
  { value: 'latest', label: 'Latest' },
  { value: 'name', label: 'A to Z' },
]

export function storeSortOf(value: unknown): StoreSort {
  return value === 'latest' || value === 'name' ? value : 'popular'
}

export function sortStoreTemplates(templates: TemplateType[], sort: StoreSort): TemplateType[] {
  if (sort === 'popular') {
    return templates
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
