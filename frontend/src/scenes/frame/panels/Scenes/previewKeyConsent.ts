import type { AppConfig, FrameScene } from '../../../../types'
import { collectSecretSettingsFromScenes } from '../secretSettings'

/**
 * The browser preview runs a scene's data apps with the account's real service
 * keys (the backend assembles them like frame.json; the cloud reveals them for
 * the session). For a scene the owner wrote that is the point. For a scene
 * from the scene store it hands someone else's code the owner's keys — so
 * those previews ask first, per settings group, and can remember the answer.
 *
 * "Cost money" was never a dialog: a browser preview only ever starts from a
 * deliberate click, and that stays the whole gate for owner-authored scenes.
 */

export const PREVIEW_KEY_DECISIONS_STORAGE_KEY = 'frameos.previewKeyDecisions'

export type PreviewKeyDecision = 'allow' | 'deny'

export interface PreviewKeyConsentRequest {
  /** What the dialog names. */
  sceneNames: string[]
  /** Settings groups the scenes declare AND the preview would hand over. */
  groups: string[]
}

export interface PreviewKeyConsentAnswer {
  decision: PreviewKeyDecision
  /** Groups whose "remember this decision" box was ticked. */
  remember: string[]
}

export function sceneHasStoreOrigin(scene: Partial<FrameScene> | null | undefined): boolean {
  return typeof (scene?.origin as { storeSceneId?: unknown } | undefined)?.storeSceneId === 'string'
}

/** Groups with a value to hand over (the fetched settings carry them). */
function groupsWithValues(settings: Record<string, unknown>): Set<string> {
  const present = new Set<string>()
  for (const [group, value] of Object.entries(settings ?? {})) {
    if (value && typeof value === 'object' && Object.values(value as Record<string, unknown>).some((v) => v)) {
      present.add(group)
    }
  }
  return present
}

/**
 * The groups a preview must ask about: declared by a store-origin scene of
 * the preview, present in the settings the preview fetched, and not covered
 * by a remembered decision. `treatAllAsStore` is for template previews from a
 * store-backed repository, whose scenes are not stamped until installed.
 */
export function previewKeyGroupsToAsk(
  scenes: FrameScene[],
  apps: Record<string, AppConfig>,
  settings: Record<string, unknown>,
  remembered: Record<string, PreviewKeyDecision>,
  treatAllAsStore = false
): string[] {
  const storeScenes = treatAllAsStore ? scenes : scenes.filter(sceneHasStoreOrigin)
  if (storeScenes.length === 0) {
    return []
  }
  const present = groupsWithValues(settings)
  return collectSecretSettingsFromScenes(storeScenes, apps)
    .filter((group) => present.has(group))
    .filter((group) => !(group in remembered))
    .sort()
}

/** Groups a remembered "deny" keeps out of every preview, no dialog. */
export function previewKeyGroupsRemembered(
  scenes: FrameScene[],
  apps: Record<string, AppConfig>,
  remembered: Record<string, PreviewKeyDecision>,
  treatAllAsStore = false
): { allowed: string[]; denied: string[] } {
  const storeScenes = treatAllAsStore ? scenes : scenes.filter(sceneHasStoreOrigin)
  const declared = storeScenes.length ? collectSecretSettingsFromScenes(storeScenes, apps) : []
  return {
    allowed: declared.filter((group) => remembered[group] === 'allow'),
    denied: declared.filter((group) => remembered[group] === 'deny'),
  }
}

/** The settings the preview gets: `denied` groups are dropped entirely. */
export function settingsWithoutGroups<T extends Record<string, unknown>>(settings: T, denied: string[]): T {
  if (denied.length === 0) {
    return settings
  }
  const result = { ...settings }
  for (const group of denied) {
    delete result[group]
  }
  return result
}

export function readRememberedPreviewKeyDecisions(
  storage: Pick<Storage, 'getItem'> | null = typeof window === 'undefined' ? null : window.localStorage
): Record<string, PreviewKeyDecision> {
  try {
    const raw = storage?.getItem(PREVIEW_KEY_DECISIONS_STORAGE_KEY)
    if (!raw) {
      return {}
    }
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') {
      return {}
    }
    const result: Record<string, PreviewKeyDecision> = {}
    for (const [group, decision] of Object.entries(parsed as Record<string, unknown>)) {
      if (decision === 'allow' || decision === 'deny') {
        result[group] = decision
      }
    }
    return result
  } catch {
    return {}
  }
}

export function rememberPreviewKeyDecisions(
  answer: PreviewKeyConsentAnswer,
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = typeof window === 'undefined' ? null : window.localStorage
): Record<string, PreviewKeyDecision> {
  const next = { ...readRememberedPreviewKeyDecisions(storage) }
  for (const group of answer.remember) {
    next[group] = answer.decision
  }
  try {
    storage?.setItem(PREVIEW_KEY_DECISIONS_STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Private mode / quota: the answer still applies to this preview.
  }
  return next
}

export function forgetPreviewKeyDecisions(
  storage: Pick<Storage, 'removeItem'> | null = typeof window === 'undefined' ? null : window.localStorage
): void {
  try {
    storage?.removeItem(PREVIEW_KEY_DECISIONS_STORAGE_KEY)
  } catch {
    // nothing to forget
  }
}
