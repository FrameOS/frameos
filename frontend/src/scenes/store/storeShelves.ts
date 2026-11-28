import type { TemplateType } from '../../types'
import { searchInText } from '../../utils/searchInText'
import {
  groupByStoreShelf,
  storeKindOf,
  storeShelfForCategory,
  type StoreCategoryShelf,
  type StoreKind,
} from '../../utils/storeCategories'
import { knownSceneNeeds } from '../../utils/sceneNeeds'
import { sortStoreTemplates, type StoreSort } from '../../utils/storeSort'

// The store's shelves as a page shows them: pure functions over the store's
// templates (its kind, its screen filter, search and sort), kept apart from
// storeCatalog.ts (which reads the repositories through the templates logic)
// so a test of them does not drag the whole SPA into the cloud typecheck.

export interface StoreShelfGroup {
  shelf: StoreCategoryShelf
  templates: TemplateType[]
}

export interface StoreShelfCount {
  shelf: StoreCategoryShelf
  count: number
}

export interface StoreFilters {
  search: string
  category: string | null
  sort?: StoreSort
  /** Scenes or layouts: the store front shows one at a time. Follows the category when there is one. */
  kind?: StoreKind
  fit?: StoreFit
}

/**
 * Which scenes a store page lists by what they need (the template's `needs`,
 * utils/sceneNeeds.ts): every scene, the ones e-paper can show (no fast
 * screen needed), the ones made for a fast screen, the ones used with touch
 * or a mouse, the ones used with a keyboard, the ones moved by tilting or
 * shaking a frame with an accelerometer, or the ones made for round screens
 * too.
 */
export type StoreFit = 'any' | 'epaper' | 'fast' | 'touch' | 'keys' | 'accelerometer' | 'round'

export const STORE_FIT_OPTIONS: { value: StoreFit; label: string }[] = [
  { value: 'any', label: 'Any screen' },
  { value: 'epaper', label: 'Fits e-paper' },
  { value: 'fast', label: 'Made for fast screens' },
  { value: 'touch', label: 'Touch & mouse' },
  { value: 'keys', label: 'Keyboard' },
  { value: 'accelerometer', label: 'Accelerometer' },
  { value: 'round', label: 'Round screens' },
]

export function storeFitOf(value: unknown): StoreFit {
  return value === 'epaper' ||
    value === 'fast' ||
    value === 'touch' ||
    value === 'keys' ||
    value === 'accelerometer' ||
    value === 'round'
    ? value
    : 'any'
}

/** The URL's `kind` (`layouts` for the Layouts side), or the kind of the shelf it names. */
export function storeKindFromRoute(kind: unknown, category: string | null): StoreKind {
  if (category) {
    return storeShelfForCategory(category).kind
  }
  return kind === 'layouts' || kind === 'layout' ? 'layout' : 'scene'
}

export function templateFitsStoreFit(template: TemplateType, fit: StoreFit): boolean {
  const needs = knownSceneNeeds(template.needs)
  if (fit === 'epaper') {
    return !needs.includes('fast')
  }
  if (fit === 'fast') {
    return needs.includes('fast')
  }
  if (fit === 'touch') {
    return needs.includes('touch')
  }
  if (fit === 'keys') {
    return needs.includes('keys')
  }
  if (fit === 'accelerometer') {
    return needs.includes('accelerometer')
  }
  if (fit === 'round') {
    return needs.includes('round')
  }
  return true
}

export interface StoreKindCounts {
  scene: number
  layout: number
}

export function storeKindCountsOf(storeTemplates: TemplateType[]): StoreKindCounts {
  const counts: StoreKindCounts = { scene: 0, layout: 0 }
  for (const template of storeTemplates) {
    counts[storeKindOf(template)] += 1
  }
  return counts
}

/** A shelf shows this many tiles while every shelf is listed; its title links to the rest. */
export const STORE_SHELF_PREVIEW_COUNT = 12

export function templateMatchesSearch(search: string, template: TemplateType): boolean {
  return (
    search === '' ||
    searchInText(search, template.name) ||
    searchInText(search, template.description) ||
    searchInText(search, template.author) ||
    (template.tags ?? []).some((tag) => searchInText(search, tag))
  )
}

/** The shelves of one kind with how many each holds (every kind when none is named). */
export function storeShelfCountsOf(storeTemplates: TemplateType[], kind?: StoreKind): StoreShelfCount[] {
  return groupByStoreShelf(storeTemplates)
    .filter(({ shelf }) => !kind || shelf.kind === kind)
    .map(({ shelf, templates }) => ({ shelf, count: templates.length }))
}

export function storeShelvesOf(
  storeTemplates: TemplateType[],
  { search, category, sort = 'newest', kind, fit = 'any' }: StoreFilters
): StoreShelfGroup[] {
  const shownKind = category ? storeShelfForCategory(category).kind : kind
  return groupByStoreShelf(
    sortStoreTemplates(storeTemplates, sort).filter(
      (template) =>
        templateMatchesSearch(search, template) &&
        (!category || storeShelfForCategory(template.category).slug === category) &&
        (!shownKind || storeKindOf(template) === shownKind) &&
        templateFitsStoreFit(template, fit)
    )
  )
}
