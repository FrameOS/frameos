/**
 * The FrameOS Cloud store's category taxonomy, in shelf order: what the
 * store front shows as its curated shelves, and what the Add scene drawer's
 * Scene store page groups the catalog by.
 *
 * The source of truth (with shelf copy and classifier hints) is
 * cloud/apps/auth-web/src/lib/categories.ts; that package's test suite checks
 * this list against it, so the two cannot drift silently. A scene carries at
 * most one category slug (`template.category` in the repository JSON).
 */
export interface StoreCategoryShelf {
  slug: string
  title: string
}

export const storeCategoryShelves: StoreCategoryShelf[] = [
  { slug: 'photos', title: 'Photos' },
  { slug: 'art', title: 'Art & galleries' },
  { slug: 'calendar', title: 'Calendars & agendas' },
  { slug: 'weather', title: 'Weather' },
  { slug: 'ai', title: 'AI & generative' },
  { slug: 'dashboards', title: 'Data & dashboards' },
  { slug: 'fun', title: 'Fun & comics' },
  { slug: 'utilities', title: 'Tools & utilities' },
  { slug: 'demos', title: 'Demos & examples' },
]

/** Scenes without a (known) category land on this shelf, after the others. */
export const OTHER_STORE_CATEGORY: StoreCategoryShelf = { slug: 'other', title: 'Other scenes' }

const shelfBySlug = new Map(storeCategoryShelves.map((shelf) => [shelf.slug, shelf]))

/** The shelf a template belongs on: its category when the taxonomy knows it, else "Other scenes". */
export function storeShelfForCategory(category: string | null | undefined): StoreCategoryShelf {
  const slug = (category ?? '').trim().toLowerCase()
  return shelfBySlug.get(slug) ?? OTHER_STORE_CATEGORY
}

/** Group templates by shelf, in shelf order, dropping empty shelves. */
export function groupByStoreShelf<T extends { category?: string }>(
  templates: T[]
): Array<{ shelf: StoreCategoryShelf; templates: T[] }> {
  const groups = new Map<string, T[]>()
  for (const template of templates) {
    const shelf = storeShelfForCategory(template.category)
    const list = groups.get(shelf.slug)
    if (list) {
      list.push(template)
    } else {
      groups.set(shelf.slug, [template])
    }
  }
  return [...storeCategoryShelves, OTHER_STORE_CATEGORY]
    .filter((shelf) => groups.has(shelf.slug))
    .map((shelf) => ({ shelf, templates: groups.get(shelf.slug) ?? [] }))
}
