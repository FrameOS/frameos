// A scene's category (`settings.category`, docs/scene-icons.md "Category"):
// its name as people read it, "Photos" or "Clocks & time", which a desktop layout
// groups its scene lists by (`category` on each app.frame.scenes entry). It is
// picked from the store's category titles (utils/storeCategories.ts) and kept
// as that text: nothing maps it to anything, and a frame lists it as it is.

import { storeCategoryShelves } from './storeCategories'

export const SCENE_CATEGORY_HELP =
  "The scene's category, by its name. A desktop layout groups its list of scenes by it, the store files the scene under it when its name is one of the store's, and a name of your own is kept as it is."

export interface SceneCategoryOption {
  value: string
  label: string
}

/**
 * The Category select's choices: None, then the store's category titles for a
 * scene (the two layout ones for a layout), and a name of the scene's own that
 * is none of them, kept as it is.
 */
export function sceneCategoryOptions(current: unknown, isLayout: boolean): SceneCategoryOption[] {
  const options: SceneCategoryOption[] = [
    { value: '', label: 'None' },
    ...storeCategoryShelves
      .filter((shelf) => (shelf.kind === 'layout') === isLayout)
      .map((shelf) => ({ value: shelf.title, label: shelf.title })),
  ]
  if (typeof current === 'string' && current && !options.some((option) => option.value === current)) {
    options.push({ value: current, label: current })
  }
  return options
}

/** The select's value as the setting: undefined (the key is dropped) for None. */
export function sceneCategoryFromSelect(value: string): string | undefined {
  return value || undefined
}

/** The store's titles a scene picks from, for a linter or a prompt: the scenes' (no layouts'). */
export function sceneCategoryTitles(isLayout = false): string[] {
  return storeCategoryShelves
    .filter((shelf) => (shelf.kind === 'layout') === isLayout)
    .map((shelf) => shelf.title)
}
