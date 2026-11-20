import { describe, expect, it } from 'vitest'
import {
  categorySlugForTitle,
  getStoreCategory,
  isLayoutCategory,
  layoutCategorySlug,
  normalizeCategory,
  sceneCategories,
  storeCategories,
} from './categories'
import { storeCategoryShelves, storeShelfDescriptions } from '../../../../../frontend/src/utils/storeCategories'

describe('storeCategories', () => {
  it('uses unique, tag-shaped slugs (they double as URL filters)', () => {
    const slugs = storeCategories.map((category) => category.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
    for (const slug of slugs) {
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]{0,23}$/)
    }
  })

  it('matches the shelf list the frameos scene picker groups the store by', () => {
    // frontend/src/utils/storeCategories.ts is the copy the Add scene
    // drawer uses (it cannot import this package); keep slugs, titles and
    // order identical so the picker's shelves are the store front's.
    expect(storeCategoryShelves).toEqual(storeCategories.map(({ slug, title, kind }) => ({ slug, title, kind })))
  })

  it('gives the store front each shelf\'s description', () => {
    for (const category of storeCategories) {
      expect(storeShelfDescriptions[category.slug]).toBe(category.description)
    }
    expect(storeShelfDescriptions.other).toBeTruthy()
  })

  it('lists the scenes\' shelves first and the layouts\' after, a layout\'s shelf by its kind', () => {
    const kinds = storeCategories.map((category) => category.kind)
    expect(kinds.indexOf('layout')).toBe(sceneCategories.length)
    expect(layoutCategorySlug(true)).toBe('desktops')
    expect(layoutCategorySlug(false)).toBe('layouts')
    expect(layoutCategorySlug(false, true)).toBe('devices')
    expect(layoutCategorySlug(true, true)).toBe('devices')
    expect(isLayoutCategory('devices')).toBe(true)
    expect(isLayoutCategory('layouts')).toBe(true)
    expect(isLayoutCategory('games')).toBe(false)
  })

  it('has no Real time shelf: a fast screen is what a scene needs, and the old slug reads as Fun', () => {
    expect(getStoreCategory('realtime')).toBeUndefined()
    expect(normalizeCategory('Realtime')).toBe('fun')
    expect(getStoreCategory('clocks')?.title).toBe('Clocks & time')
    expect(getStoreCategory('games')?.title).toBe('Games')
  })

  it('gives every category shelf copy and a classifier hint', () => {
    for (const category of storeCategories) {
      expect(category.title.length).toBeGreaterThan(0)
      expect(category.description.length).toBeGreaterThan(0)
      expect(category.hint.length).toBeGreaterThan(0)
    }
  })
})

describe('normalizeCategory', () => {
  it('accepts taxonomy slugs, case-insensitively', () => {
    expect(normalizeCategory('photos')).toBe('photos')
    expect(normalizeCategory('  Weather ')).toBe('weather')
  })

  it('treats null and empty string as clearing the category', () => {
    expect(normalizeCategory(null)).toBeNull()
    expect(normalizeCategory('')).toBeNull()
    expect(normalizeCategory('  ')).toBeNull()
  })

  it('rejects unknown slugs and non-strings', () => {
    expect(normalizeCategory('misc')).toBeUndefined()
    expect(normalizeCategory(42)).toBeUndefined()
    expect(normalizeCategory(['photos'])).toBeUndefined()
    expect(normalizeCategory(undefined)).toBeUndefined()
  })
})

describe('getStoreCategory', () => {
  it('resolves slugs to categories and everything else to undefined', () => {
    expect(getStoreCategory('art')?.title).toBe('Art & galleries')
    expect(getStoreCategory('nope')).toBeUndefined()
    expect(getStoreCategory(null)).toBeUndefined()
    expect(getStoreCategory(undefined)).toBeUndefined()
  })
})

describe('categorySlugForTitle', () => {
  it("is the store category a scene names by its title (settings.category)", () => {
    expect(categorySlugForTitle('Art & galleries')).toBe('art')
    expect(categorySlugForTitle(' Real time ')).toBe('fun')
    expect(categorySlugForTitle('Data & dashboards')).toBe('dashboards')
    expect(categorySlugForTitle('Clocks & time')).toBe('clocks')
    expect(categorySlugForTitle('art')).toBeUndefined()
    expect(categorySlugForTitle('Clocks')).toBeUndefined()
    expect(categorySlugForTitle(undefined)).toBeUndefined()
  })
})
