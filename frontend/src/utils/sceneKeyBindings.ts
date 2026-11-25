// Which key each service an installed scene declares gets, as the SPA draws
// it (docs/service-keys.md "Which key a scene gets"): the install's own `keys`
// when the owner chose, else the plane's older grant. The rule itself is
// resolveSceneKeyBindings (utils/serviceKeys.ts, pinned by the corpus); this
// only says what the older grant is for one scene of a frame.

import type { CloudSceneSource, FrameScene, FrameType } from '../types'
import { DEFAULT_KEY_REF, type SceneKeyBindings, readServiceCredentials, resolveSceneKeyBindings } from './serviceKeys'

/** A scene from the public scene store on a backend (`origin.storeSceneId`): anyone's code. */
export function isStoreScene(scene: Partial<FrameScene> | null | undefined): boolean {
  return typeof scene?.origin?.storeSceneId === 'string' && !!scene.origin.storeSceneId
}

/**
 * The plane's older grant for one scene: on a backend everything a scene the
 * owner made declares, and for a store scene the frame's
 * `service_setting_groups`; on the cloud the assignment's grant (a scene
 * built in the workspace and not saved yet: all it declares, as its first
 * save grants).
 */
export function legacyGrantedServices(
  scene: Partial<FrameScene>,
  declared: readonly string[],
  frame: Partial<FrameType> | null | undefined,
  options: { cloud: boolean; source?: CloudSceneSource | null }
): string[] {
  if (options.cloud) {
    return options.source ? [...(options.source.granted_settings_groups ?? [])] : [...declared]
  }
  return isStoreScene(scene) ? [...(frame?.service_setting_groups ?? [])] : [...declared]
}

/**
 * The key each service a scene declares gets now. `declared`: the services
 * its apps declare (secretSettings.ts collectSecretSettingsFromScenes).
 */
export function sceneKeyBindings(
  scene: Partial<FrameScene> | null | undefined,
  declared: readonly string[],
  frame: Partial<FrameType> | null | undefined,
  credentials: unknown,
  options: { cloud: boolean; source?: CloudSceneSource | null }
): SceneKeyBindings {
  if (!scene) {
    return {}
  }
  return resolveSceneKeyBindings({
    declared,
    keys: scene.keys,
    legacyGranted: legacyGrantedServices(scene, declared, frame, options),
    credentials: readServiceCredentials(credentials),
  })
}

/** What an install records when the owner gives a new scene the keys its apps declare (installing is consent). */
export function defaultKeyBindings(declared: readonly string[]): SceneKeyBindings {
  return Object.fromEntries([...declared].sort().map((service) => [service, DEFAULT_KEY_REF]))
}

/**
 * A cloud assignment's key choices after its grant was changed by the grant
 * checkboxes: a service taken away is refused in every choice, one given
 * back that a choice refused gets the default. `undefined` when the row has
 * no choices (the grant alone decides then).
 */
export function serviceKeysFollowingGrant(
  serviceKeys: Record<string, Record<string, string | null>> | null | undefined,
  granted: readonly string[]
): Record<string, Record<string, string | null>> | undefined {
  if (!serviceKeys || Object.keys(serviceKeys).length === 0) {
    return undefined
  }
  const result: Record<string, Record<string, string | null>> = {}
  for (const [runtimeId, bindings] of Object.entries(serviceKeys)) {
    result[runtimeId] = Object.fromEntries(
      Object.entries(bindings).map(([service, ref]) => [
        service,
        !granted.includes(service) ? null : ref === null ? DEFAULT_KEY_REF : ref,
      ])
    )
  }
  return result
}
