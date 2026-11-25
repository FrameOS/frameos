// The flasher's list of samples (FlasherApp.tsx): each one's picture and its
// Scene store page. Kept apart from standalone.ts, whose board tables reach the
// shared workspace components, so that auth-web's strict typecheck reads it.
import { compareFlasherCategories, type FlasherSample } from './sampleCatalog'

/** A sample's store listing, for its thumbnail: its cover and its page. */
export interface StoreCover {
  /** The cover, as the flasher's own host serves it (surfaces.ts flasherServesApi). */
  image: string
  /** The scene's store page, opened in a new tab. */
  url: string
}

/** The store's public listing (/api/store/repository.json), read for the
 * covers of the samples it carries, by name in lower case. A sample the store
 * does not carry has none; a listing that is not one gives none. */
export function storeCoversFromListing(listing: unknown, listingUrl: string): Record<string, StoreCover> {
  const covers: Record<string, StoreCover> = {}
  const templates = listing && typeof listing === 'object' ? (listing as Record<string, unknown>).templates : undefined
  if (!Array.isArray(templates)) {
    return covers
  }
  for (const entry of templates) {
    if (!entry || typeof entry !== 'object') {
      continue
    }
    const { name, image, url } = entry as Record<string, unknown>
    if (typeof name !== 'string' || typeof image !== 'string' || typeof url !== 'string') {
      continue
    }
    try {
      const page = new URL(url)
      if (page.protocol !== 'https:' && page.protocol !== 'http:') {
        continue
      }
      covers[name.toLowerCase()] = { image: new URL(image, listingUrl).href, url: page.href }
    } catch {
      // Not a URL: no thumbnail for it.
    }
  }
  return covers
}

// The samples a standalone frame can start with (build.mjs, sampleCatalog.ts):
// the index, each sample's scenes and its picture beside it.
export const FLASHER_SAMPLES_URL = '/frames-app/flasher-scenes/'

/** One sample as the list shows it. */
export interface FlasherSampleRow {
  sample: FlasherSample
  picked: boolean
  /** Its store cover and page, when the store carries it. */
  cover: StoreCover | null
  /** The picture the list shows: the sample's own (build.mjs), else its store cover. */
  picture: string | null
}

export interface FlasherSampleGroup {
  category: string
  rows: FlasherSampleRow[]
}

function matchesQuery(sample: FlasherSample, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  // Its folder name too: "books" finds the ePub reader.
  const text = `${sample.title} ${sample.name} ${sample.description} ${sample.category}`.toLowerCase()
  return words.every((word) => text.includes(word))
}

/** The list: by category, the Scene store's group first, a search applied. */
export function flasherSampleGroups(
  samples: FlasherSample[] | null,
  picked: readonly string[],
  covers: Record<string, StoreCover>,
  query: string
): FlasherSampleGroup[] {
  const groups = new Map<string, FlasherSampleRow[]>()
  for (const sample of samples ?? []) {
    if (query.trim() && !matchesQuery(sample, query)) {
      continue
    }
    const rows = groups.get(sample.category) ?? []
    // The store lists a scene by its title, which is the sample's template name.
    const cover = covers[sample.title.toLowerCase()] ?? covers[sample.name.toLowerCase()] ?? null
    rows.push({
      sample,
      picked: sample.store || picked.includes(sample.name),
      cover,
      picture: sample.thumb ? `${FLASHER_SAMPLES_URL}${encodeURIComponent(sample.thumb)}` : (cover?.image ?? null),
    })
    groups.set(sample.category, rows)
  }
  const hasStore = (group: FlasherSampleGroup): number => Number(group.rows.some((row) => row.sample.store))
  return [...groups.entries()]
    .map(([category, rows]) => ({ category, rows }))
    .sort((a, b) => hasStore(b) - hasStore(a) || compareFlasherCategories(a.category, b.category))
}
