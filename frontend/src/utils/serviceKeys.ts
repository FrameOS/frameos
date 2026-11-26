/**
 * Service keys: which key of which service each scene on a frame may use,
 * and what the frame is sent. docs/service-keys.md is the contract,
 * docs/service-keys-fixtures.json the corpus (runners: the cloud's
 * shared-spa/service-keys-fixtures.test.ts, the backend's
 * app/utils/tests/test_service_keys.py, which replays app/utils/service_keys.py).
 *
 * One implementation for the SPA (both control planes) and the cloud server:
 * plain TypeScript on unknown input, importing only the generated registry.
 */
import { PLANE_SETTINGS_GROUPS, SERVICE_REGISTRY, type RegistryService } from '../generated/services.gen'

export const SERVICE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,40}$/
export const SERVICE_FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,40}$/
export const CREDENTIAL_ID_PATTERN = /^k_[a-z0-9]{8,24}$/
/** The settings group that holds every credential beyond a service's default. */
export const SERVICE_CREDENTIALS_GROUP = 'serviceCredentials'
/** The ref of a service's default credential: the settings group named after the service. */
export const DEFAULT_KEY_REF = 'default'

export type ServiceField = {
  name: string
  label: string
  secret: boolean
  placeholder?: string
  hint?: string
}

export type ServiceDefinition = {
  id: string
  title: string
  description?: string
  help?: string
  optional?: boolean
  fields: ServiceField[]
  hosts?: string[]
  hostsFrom?: string
  /** In repo/services.json; otherwise defined by an app (its config.json `services`) or by nothing at all. */
  registered: boolean
}

/** A credential beyond a service's default, as the `serviceCredentials` settings group keeps it. */
export type ServiceCredential = {
  service: string
  name: string
  values: Record<string, string>
}

/** `null` is a key the owner refused this scene; a string is `"default"` or a credential id. */
export type SceneKeyBindings = Record<string, string | null>

/** What a frame is sent: docs/service-keys.md "On the wire". */
export type ServiceKeysWire = {
  v: 1
  keys: Record<string, { service: string; values: Record<string, string> }>
  scenes: Record<string, Record<string, string | null>>
  services: Record<
    string,
    {
      title: string
      fields: { name: string; label: string; secret?: false }[]
      hosts?: string[]
      hostsFrom?: string
    }
  >
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** A name a service may have: the namespace pattern, and never one of a plane's own settings groups. */
export function isServiceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    SERVICE_ID_PATTERN.test(value) &&
    !CREDENTIAL_ID_PATTERN.test(value) &&
    !PLANE_SETTINGS_GROUPS.includes(value)
  )
}

export function isCredentialId(value: unknown): value is string {
  return typeof value === 'string' && CREDENTIAL_ID_PATTERN.test(value)
}

export function registeredService(id: string): RegistryService | undefined {
  return Object.prototype.hasOwnProperty.call(SERVICE_REGISTRY, id) ? SERVICE_REGISTRY[id] : undefined
}

function readField(value: unknown): ServiceField | null {
  if (!isRecord(value) || typeof value.name !== 'string' || !SERVICE_FIELD_PATTERN.test(value.name)) {
    return null
  }
  const field: ServiceField = {
    name: value.name,
    label: typeof value.label === 'string' && value.label ? value.label : value.name,
    secret: value.secret !== false,
  }
  if (typeof value.placeholder === 'string' && value.placeholder) field.placeholder = value.placeholder
  if (typeof value.hint === 'string' && value.hint) field.hint = value.hint
  return field
}

/**
 * The services an app defines for itself (its config.json `services`): only
 * ids it is not given by the registry, title and fields only. An app never
 * says where a key may go (`hosts`): that is the registry's alone.
 */
export function appServiceDefinitions(appConfig: unknown): Record<string, ServiceDefinition> {
  const result: Record<string, ServiceDefinition> = {}
  const services = isRecord(appConfig) ? appConfig.services : undefined
  if (!isRecord(services)) {
    return result
  }
  for (const [id, spec] of Object.entries(services)) {
    if (!isServiceId(id) || registeredService(id) || !isRecord(spec)) {
      continue
    }
    const fields: ServiceField[] = []
    for (const raw of Array.isArray(spec.fields) ? spec.fields : []) {
      const field = readField(raw)
      if (field && !fields.some((f) => f.name === field.name)) {
        fields.push(field)
      }
    }
    result[id] = {
      id,
      title: typeof spec.title === 'string' && spec.title.trim() ? spec.title.trim() : id,
      ...(typeof spec.description === 'string' && spec.description ? { description: spec.description } : {}),
      fields,
      registered: false,
    }
  }
  return result
}

/**
 * The definition a form draws: the registry's entry, else what an app
 * defined, else the bare id with the fields a stored value happens to have.
 */
export function serviceDefinition(
  id: string,
  appDefinitions?: Record<string, ServiceDefinition> | null,
  storedValues?: unknown
): ServiceDefinition {
  const registered = registeredService(id)
  if (registered) {
    return {
      id,
      title: registered.title,
      ...(registered.description ? { description: registered.description } : {}),
      ...(registered.help ? { help: registered.help } : {}),
      ...(registered.optional ? { optional: true } : {}),
      fields: registered.fields.map((field) => ({ ...field })),
      ...(registered.hosts ? { hosts: [...registered.hosts] } : {}),
      ...(registered.hostsFrom ? { hostsFrom: registered.hostsFrom } : {}),
      registered: true,
    }
  }
  const defined = appDefinitions?.[id]
  const fields = defined ? defined.fields.map((field) => ({ ...field })) : []
  if (isRecord(storedValues)) {
    for (const [name, value] of Object.entries(storedValues)) {
      if (typeof value === 'string' && SERVICE_FIELD_PATTERN.test(name) && !fields.some((f) => f.name === name)) {
        fields.push({ name, label: name, secret: true })
      }
    }
  }
  if (fields.length === 0) {
    fields.push({ name: 'apiKey', label: 'API key', secret: true })
  }
  return {
    id,
    title: defined?.title ?? id,
    ...(defined?.description ? { description: defined.description } : {}),
    fields,
    registered: false,
  }
}

export function serviceTitle(id: string, appDefinitions?: Record<string, ServiceDefinition> | null): string {
  return registeredService(id)?.title ?? appDefinitions?.[id]?.title ?? id
}

/**
 * Whether a stored field of a service group is a secret: a registered
 * service's field says so itself (secret unless `"secret": false`); a field
 * the registry does not list for a registered service is the plane's own
 * (`null`: the plane's list decides, e.g. Home Assistant's MQTT settings);
 * every field of a service the registry does not know is a secret.
 */
export function serviceFieldSecrecy(id: string, field: string): boolean | null {
  const registered = registeredService(id)
  if (!registered) {
    return true
  }
  const known = registered.fields.find((f) => f.name === field)
  return known ? known.secret : null
}

/**
 * The values of one credential a frame may be sent: a registered service's
 * registry fields alone (a plane's own fields in the same group, such as
 * `openAI.backendApiKey`, never ship), every field of an unregistered one;
 * non-empty strings only. `null` when nothing usable is left.
 */
export function deliverableServiceValues(id: string, stored: unknown): Record<string, string> | null {
  if (!isRecord(stored)) {
    return null
  }
  const registered = registeredService(id)
  const allowed = registered ? new Set(registered.fields.map((field) => field.name)) : null
  const values: Record<string, string> = {}
  for (const name of Object.keys(stored).sort()) {
    const value = stored[name]
    if (!SERVICE_FIELD_PATTERN.test(name) || (allowed && !allowed.has(name))) {
      continue
    }
    if (typeof value === 'string' && value !== '') {
      values[name] = value
    }
  }
  return Object.keys(values).length > 0 ? values : null
}

/** The `serviceCredentials` settings group, read defensively: id → credential. */
export function readServiceCredentials(value: unknown): Record<string, ServiceCredential> {
  const result: Record<string, ServiceCredential> = {}
  if (!isRecord(value)) {
    return result
  }
  for (const [id, raw] of Object.entries(value)) {
    if (!isCredentialId(id) || !isRecord(raw) || !isServiceId(raw.service)) {
      continue
    }
    const values: Record<string, string> = {}
    if (isRecord(raw.values)) {
      for (const [name, v] of Object.entries(raw.values)) {
        if (SERVICE_FIELD_PATTERN.test(name) && typeof v === 'string') {
          values[name] = v
        }
      }
    }
    result[id] = {
      service: raw.service,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id,
      values,
    }
  }
  return result
}

/** An install's `keys` map, read defensively: service → `"default"`, a credential id, or null. */
export function readSceneKeyBindings(value: unknown): SceneKeyBindings {
  const result: SceneKeyBindings = {}
  if (!isRecord(value)) {
    return result
  }
  for (const [service, ref] of Object.entries(value)) {
    if (!isServiceId(service)) {
      continue
    }
    if (ref === null || ref === false) {
      result[service] = null
    } else if (ref === DEFAULT_KEY_REF || isCredentialId(ref)) {
      result[service] = ref
    }
  }
  return result
}

/**
 * Which key each service a scene declares gets (docs/service-keys.md
 * "Which key a scene gets"). For every declared service:
 *  1. the install's own `keys[service]`: null is refused; `"default"` is the
 *     default; a credential id is that credential if it still exists for
 *     that service, else refused (a removed key is never swapped for another);
 *  2. else `"default"` when the plane's older grant covers it
 *     (`legacyGranted`: a backend's own scenes all they declare, a store
 *     scene the frame's `service_setting_groups`; the cloud's assignment grant);
 *  3. else refused.
 */
export function resolveSceneKeyBindings({
  declared,
  keys,
  legacyGranted,
  credentials,
}: {
  declared: readonly string[]
  keys?: unknown
  legacyGranted?: readonly string[] | null | undefined
  credentials?: Record<string, ServiceCredential> | null | undefined
}): SceneKeyBindings {
  const bindings = readSceneKeyBindings(keys)
  const granted = new Set(legacyGranted ?? [])
  const result: SceneKeyBindings = {}
  for (const service of [...new Set(declared)].filter(isServiceId).sort()) {
    if (Object.prototype.hasOwnProperty.call(bindings, service)) {
      const ref = bindings[service]
      if (ref === DEFAULT_KEY_REF) {
        result[service] = DEFAULT_KEY_REF
      } else if (typeof ref === 'string' && credentials?.[ref]?.service === service) {
        result[service] = ref
      } else {
        result[service] = null
      }
    } else {
      result[service] = granted.has(service) ? DEFAULT_KEY_REF : null
    }
  }
  return result
}

export type ServiceKeysScene = {
  /** The scene's id on the frame (a backend's scene id, the cloud's runtime scene id). */
  id: string
  /** The services its apps declare (their config.json `settings`). */
  declared: readonly string[]
  /** The install's `keys`. */
  keys?: unknown
  legacyGranted?: readonly string[] | null | undefined
  /** Its apps' own service definitions, for the labels of an unregistered service. */
  appDefinitions?: Record<string, ServiceDefinition> | null | undefined
}

/**
 * Everything a frame is sent about keys: `serviceKeys` (docs/service-keys.md
 * "On the wire") and the older `settings` groups for runtimes that do not
 * read it yet. `settings` is the plane's stored settings (the default
 * credential of a service is the group of its name); `credentials` the
 * `serviceCredentials` group.
 */
export function buildServiceKeysWire({
  scenes,
  settings,
  credentials,
}: {
  scenes: readonly ServiceKeysScene[]
  settings: Record<string, unknown> | null | undefined
  credentials?: unknown
}): { serviceKeys: ServiceKeysWire; settings: Record<string, Record<string, string>> } {
  const stored = isRecord(settings) ? settings : {}
  const creds = readServiceCredentials(credentials ?? stored[SERVICE_CREDENTIALS_GROUP])
  const wire: ServiceKeysWire = { v: 1, keys: {}, scenes: {}, services: {} }
  const definitions: Record<string, ServiceDefinition> = {}
  const usesDefault = new Set<string>()
  const boundKeyIds: Record<string, Set<string>> = {}

  for (const scene of [...scenes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const bindings = resolveSceneKeyBindings({
      declared: scene.declared,
      keys: scene.keys,
      legacyGranted: scene.legacyGranted,
      credentials: creds,
    })
    const services = Object.keys(bindings)
    if (services.length === 0) {
      continue
    }
    const entry: Record<string, string | null> = {}
    for (const service of services) {
      if (!definitions[service]) {
        definitions[service] = serviceDefinition(service, scene.appDefinitions, stored[service])
      }
      const ref = bindings[service]
      if (typeof ref !== 'string') {
        entry[service] = null
        continue
      }
      const keyId = ref === DEFAULT_KEY_REF ? service : ref
      entry[service] = keyId
      if (ref === DEFAULT_KEY_REF) {
        usesDefault.add(service)
      }
      ;(boundKeyIds[service] ??= new Set()).add(keyId)
      if (!wire.keys[keyId]) {
        const values = deliverableServiceValues(service, ref === DEFAULT_KEY_REF ? stored[service] : creds[ref]?.values)
        if (values) {
          wire.keys[keyId] = { service, values }
        }
      }
    }
    wire.scenes[scene.id] = entry
  }

  for (const id of Object.keys(definitions).sort()) {
    const definition = definitions[id]
    if (!definition) {
      continue
    }
    wire.services[id] = {
      title: definition.title,
      fields: definition.fields.map((field) =>
        field.secret
          ? { name: field.name, label: field.label }
          : { name: field.name, label: field.label, secret: false }
      ),
      ...(definition.hosts ? { hosts: [...definition.hosts] } : {}),
      ...(definition.hostsFrom ? { hostsFrom: definition.hostsFrom } : {}),
    }
  }

  // The older `settings` groups: one set of values a service, for runtimes
  // that read `settings` alone — the default's when any scene uses it, else
  // the first credential bound (by id).
  const legacy: Record<string, Record<string, string>> = {}
  for (const service of Object.keys(boundKeyIds).sort()) {
    const keyId =
      usesDefault.has(service) && wire.keys[service]
        ? service
        : [...(boundKeyIds[service] ?? [])].sort().find((id) => wire.keys[id])
    const key = keyId ? wire.keys[keyId] : undefined
    if (key) {
      legacy[service] = { ...key.values }
    }
  }

  return { serviceKeys: wire, settings: legacy }
}

/** The service ids an app's config declares (its `settings` list). */
export function declaredServices(appConfig: unknown): string[] {
  const list = isRecord(appConfig) ? appConfig.settings : undefined
  return Array.isArray(list) ? [...new Set(list.filter(isServiceId))].sort() : []
}

/** A new credential id. */
export function newCredentialId(random: () => number = Math.random): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let id = 'k_'
  for (let i = 0; i < 12; i++) {
    id += alphabet[Math.floor(random() * alphabet.length) % alphabet.length]
  }
  return id
}

// ---------------------------------------------------------------------------
// Helpers for the SPA's forms (additions; the rules above are what the corpus pins).
// ---------------------------------------------------------------------------

/** The install's `keys`, read off an installed scene (frame.scenes entry or hydrated cloud scene). */
export function sceneKeysOf(scene: unknown): SceneKeyBindings {
  return readSceneKeyBindings(isRecord(scene) ? scene.keys : undefined)
}

/** The scene with `keys` set to the bindings, or without the key when there are none. */
export function withSceneKeys<T extends object>(scene: T, keys: SceneKeyBindings | null | undefined): T {
  const { keys: _dropped, ...rest } = scene as T & { keys?: unknown }
  const clean = readSceneKeyBindings(keys)
  return (Object.keys(clean).length > 0 ? { ...rest, keys: clean } : rest) as T
}

/** The scene without the installed copy's key choices: what a template, a zip or a store version carries. */
export function withoutSceneKeys<T extends object>(scene: T): T {
  if (!scene || !('keys' in scene)) {
    return scene
  }
  const { keys: _dropped, ...rest } = scene as T & { keys?: unknown }
  return rest as T
}

/** The named keys (credentials beyond the default) the owner keeps for one service, by name. */
export function credentialsForService(credentials: unknown, service: string): { id: string; name: string }[] {
  return Object.entries(readServiceCredentials(credentials))
    .filter(([, credential]) => credential.service === service)
    .map(([id, credential]) => ({ id, name: credential.name }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

/** How a binding reads in a menu or a tag: "Default key", a key's name, "Not given". */
export function keyRefLabel(ref: string | null | undefined, credentials?: unknown): string {
  if (ref === null || ref === undefined) {
    return 'Not given'
  }
  if (ref === DEFAULT_KEY_REF) {
    return 'Default key'
  }
  return readServiceCredentials(credentials)[ref]?.name ?? 'Removed key'
}

/** The services among `bindings` the scene is given a key for (not refused). */
export function grantedServices(bindings: SceneKeyBindings): string[] {
  return Object.keys(bindings)
    .filter((service) => bindings[service] !== null)
    .sort()
}

/**
 * The services a stored settings object holds a group for, beyond the
 * registry's: what the settings page lists next to the registered ones.
 */
export function storedServiceIds(settings: unknown): string[] {
  if (!isRecord(settings)) {
    return []
  }
  const ids = new Set<string>()
  for (const [key, value] of Object.entries(settings)) {
    if (isServiceId(key) && isRecord(value)) {
      ids.add(key)
    }
  }
  for (const credential of Object.values(readServiceCredentials(settings[SERVICE_CREDENTIALS_GROUP]))) {
    ids.add(credential.service)
  }
  return [...ids].sort()
}
