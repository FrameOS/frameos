import { describe, expect, it } from 'vitest'
import { getStoreCategory, normalizeCategory, storeCategories } from './categories'
import { storeCategoryShelves } from '../../../../../frontend/src/utils/storeCategories'

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
    expect(storeCategoryShelves).toEqual(storeCategories.map(({ slug, title }) => ({ slug, title })))
  })

  it('has a shelf for real-time scenes (animations, fast panels)', () => {
    expect(getStoreCategory('realtime')?.title).toBe('Real time')
    expect(normalizeCategory('Realtime')).toBe('realtime')
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
