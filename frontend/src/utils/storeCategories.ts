/**
 * The FrameOS Cloud store's category taxonomy, in shelf order: what the
 * store front shows as its curated shelves, what the Add scene drawer's
 * Scene store page groups the catalog by, and what a scene's own
 * `settings.category` may name.
 *
 * The source of truth is docs/scene-categories.json:
 * frameos/tools/generate_scene_categories.py writes the region below, the
 * cloud's categories.ts (with the shelf copy and classifier hints) and the
 * runtime's table. A scene carries at most one category slug
 * (`template.category` in the repository JSON).
 */
export interface StoreCategoryShelf {
  slug: string
  title: string
}

// BEGIN GENERATED: scene categories (frameos/tools/generate_scene_categories.py, docs/scene-categories.json)
export const storeCategoryShelves: StoreCategoryShelf[] = [
  { slug: 'photos', title: 'Photos' },
  { slug: 'art', title: 'Art & galleries' },
  { slug: 'calendar', title: 'Calendars & agendas' },
  { slug: 'weather', title: 'Weather' },
  { slug: 'ai', title: 'AI & generative' },
  { slug: 'dashboards', title: 'Data & dashboards' },
  { slug: 'fun', title: 'Fun & comics' },
  { slug: 'realtime', title: 'Real time' },
  { slug: 'desktops', title: 'Desktop layouts' },
  { slug: 'layouts', title: 'Full screen layouts' },
  { slug: 'utilities', title: 'Tools & utilities' },
  { slug: 'demos', title: 'Demos & examples' },
]

/** Each category's short name: a folder's label, a group of a scene list (`app.frame.categories`). */
export const sceneCategoryNames: Record<string, string> = {
  photos: 'Photos',
  art: 'Art',
  calendar: 'Calendars',
  weather: 'Weather',
  ai: 'AI',
  dashboards: 'Dashboards',
  fun: 'Fun',
  realtime: 'Real time',
  desktops: 'Desktops',
  layouts: 'Layouts',
  utilities: 'Utilities',
  demos: 'Demos',
}
// END GENERATED: scene categories

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

// A scene's own category (`settings.category`, docs/scene-icons.md "Category"):
// one of the slugs above, which a desktop layout groups its scene lists by
// (`app.frame.scenes[i].category`). The runtime reads it with the same rule
// (scene_category.nim), pinned by docs/scene-category-fixtures.json. Any other
// value stays in the scene and counts as none.

export const SCENE_CATEGORY_HELP =
  "The store's category for this scene. A desktop layout groups its scene lists by it, and the store files the scene under it."

/** The slugs a layout's own category may be; every other one is a scene's. */
const LAYOUT_CATEGORY_SLUGS = new Set(['desktops', 'layouts'])

/** `value` as a category slug (trimmed, lower case), or null when the store has no such category. */
export function sceneCategorySlug(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const slug = value.trim().toLowerCase()
  return shelfBySlug.has(slug) ? slug : null
}

export interface SceneCategoryOption {
  value: string
  label: string
}

/** The Category select's choices: None, then the store's categories for a scene (or a layout), and a value of the scene's own the store does not know. */
export function sceneCategoryOptions(current: unknown, isLayout: boolean): SceneCategoryOption[] {
  const options: SceneCategoryOption[] = [
    { value: '', label: 'None' },
    ...storeCategoryShelves
      .filter((shelf) => LAYOUT_CATEGORY_SLUGS.has(shelf.slug) === isLayout)
      .map((shelf) => ({ value: shelf.slug, label: shelf.title })),
  ]
  const slug = sceneCategorySlug(current)
  if (slug && !options.some((option) => option.value === slug)) {
    options.push({ value: slug, label: storeShelfForCategory(slug).title })
  } else if (!slug && typeof current === 'string' && current.trim()) {
    // Kept as it is, and said to be none.
    options.push({ value: current, label: `${current} (not a store category)` })
  }
  return options
}

/** The select's value as the setting: undefined (the key is dropped) for None. */
export function sceneCategoryFromSelect(value: string): string | undefined {
  return value || undefined
}
