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
  /** What the shelf holds: scenes, or layouts (which the store front shows apart, under Layouts). */
  kind: StoreKind
}

/** The store front's first split: scenes, and the layouts that go around them. */
export type StoreKind = 'scene' | 'layout'

export const storeCategoryShelves: StoreCategoryShelf[] = [
  { slug: 'photos', title: 'Photos', kind: 'scene' },
  { slug: 'art', title: 'Art & galleries', kind: 'scene' },
  { slug: 'video', title: 'Video', kind: 'scene' },
  { slug: 'clocks', title: 'Clocks & time', kind: 'scene' },
  { slug: 'calendar', title: 'Calendars & agendas', kind: 'scene' },
  { slug: 'weather', title: 'Weather', kind: 'scene' },
  { slug: 'transit', title: 'Transit', kind: 'scene' },
  { slug: 'dashboards', title: 'Home & dashboards', kind: 'scene' },
  { slug: 'games', title: 'Games', kind: 'scene' },
  { slug: 'fun', title: 'Fun & animations', kind: 'scene' },
  { slug: 'utilities', title: 'Notes & tools', kind: 'scene' },
  { slug: 'ai', title: 'AI & generative', kind: 'scene' },
  { slug: 'demos', title: 'Demos & examples', kind: 'scene' },
  { slug: 'system', title: 'System', kind: 'scene' },
  { slug: 'desktops', title: 'Multi app layouts', kind: 'layout' },
  { slug: 'layouts', title: 'Single app layouts', kind: 'layout' },
  { slug: 'devices', title: 'Device layouts', kind: 'layout' },
]

/**
 * The line under each shelf's title on the store front, by slug: the cloud's
 * `description` (categories.test.ts keeps them equal).
 */
export const storeShelfDescriptions: Record<string, string> = {
  photos: 'Your own pictures on the frame: albums, slideshows, and photo services like Google Photos or Immich.',
  art: 'Curated image collections that rotate on a schedule, no configuration needed.',
  video:
    'Films and video clips on the frame: your own videos, Immich, old films from the Internet Archive and a film slowed down for e-paper. Plays on a Raspberry Pi.',
  clocks: 'Clocks of every kind, timers and the year at a glance.',
  calendar: 'Upcoming events and schedules, straight from your calendar.',
  weather: 'Current conditions and forecasts at a glance.',
  transit: 'The next departures from your stops: buses, trams, metro, trains and ferries, live where the agency predicts them.',
  dashboards: 'Smart home remotes, maps, charts and stats from the services you care about.',
  games: 'Puzzles, card and board games for a touch screen, and arcade games for a fast one.',
  fun: 'Comics, toys and animations that make you smile.',
  utilities: 'To-dos, notes, drawing, and practical helpers like webcams and web page screenshots.',
  ai: 'Scenes that generate fresh images or words with AI on every refresh.',
  demos: 'Small demos, made-up data and test patterns to learn from or remix.',
  system: "The frame's own apps: the scene store, its files, a terminal, a code editor, fonts, readers and a calculator.",
  desktops: "Desktops that run the frame's scenes side by side, in windows or tiles.",
  layouts: 'Title bars, status lines and picture frames drawn around the one scene that is showing.',
  devices:
    'Made for one device: what its keys do, written beside them, and its touch screen, battery and signal looked after.',
  other: 'Scenes not filed on any shelf yet.',
}

/** The store's kind of a template: a layout's shelf says so, and so does the template itself. */
export function storeKindOf(template: { category?: string | null; isLayout?: boolean | null }): StoreKind {
  if (template.isLayout === true) {
    return 'layout'
  }
  return storeShelfForCategory(template.category).kind
}

/** Scenes without a (known) category land on this shelf, after the others. */
export const OTHER_STORE_CATEGORY: StoreCategoryShelf = { slug: 'other', title: 'Other scenes', kind: 'scene' }

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
