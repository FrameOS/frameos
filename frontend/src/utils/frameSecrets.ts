import type { FrameType } from '../types'

/**
 * The deploy baseline (`frame.last_successful_deploy`) holds no secrets: the
 * backend stores an HMAC fingerprint per secret leaf instead
 * (`backend/app/utils/frame_secrets.py`) and serves the frame row's *current*
 * fingerprints beside it as `frame.secret_fingerprints`. The browser already
 * holds the current secrets from its per-frame GET, so it can fill a secret
 * back into the baseline wherever the two fingerprints agree — that secret is
 * unchanged since the deploy and compares equal — and leave it out where they
 * differ, so a rotated secret shows as "changed since deploy". Neither the
 * broadcast nor the stored snapshot ever carries the value itself.
 */

// Mirrors TOP_LEVEL_SECRET_KEYS + NESTED_SECRET_PATHS on the backend; "*"
// walks a list. A path the backend fingerprints but this list lacks makes
// that leaf "changed since deploy" forever (the baseline has no value, the
// row does), which is how "Network settings" stayed pending after every
// fast deploy once the Wi-Fi passwords became secrets — the shared-spa
// `frame-secrets-mirror` test reads the backend list and fails on drift.
export const SECRET_PATHS: readonly (readonly string[])[] = [
  ['ssh_pass'],
  ['server_api_key'],
  ['frame_access_key'],
  ['https_proxy', 'certs', 'server_key'],
  ['agent', 'agentSharedSecret'],
  ['frame_admin_auth', 'pass'],
  ['mountpoints', 'items', '*', 'password'],
  ['network', 'wifiPassword'],
  ['network', 'wifiHotspotPassword'],
]

const FINGERPRINTS_KEY = 'secret_fingerprints'

type Leaf = { container: Record<string, unknown>; key: string; dotted: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function* walk(value: unknown, path: readonly string[], prefix = ''): Generator<Leaf> {
  const [head, ...rest] = path
  if (head === undefined) {
    return
  }
  if (head === '*') {
    if (!Array.isArray(value)) {
      return
    }
    for (let index = 0; index < value.length; index++) {
      yield* walk(value[index], rest, `${prefix}${index}.`)
    }
    return
  }
  if (!isRecord(value) || !(head in value)) {
    return
  }
  if (rest.length === 0) {
    yield { container: value, key: head, dotted: `${prefix}${head}` }
    return
  }
  yield* walk(value[head], rest, `${prefix}${head}.`)
}

function fingerprintsOf(value: unknown): Record<string, string> {
  const fingerprints = isRecord(value) ? value[FINGERPRINTS_KEY] : undefined
  return isRecord(fingerprints) ? (fingerprints as Record<string, string>) : {}
}

/** Deep-copies only the containers a secret can live in, so filling a leaf
 * in never mutates the frame store's snapshot object. */
function copyTouched(snapshot: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...snapshot }
  for (const [container] of SECRET_PATHS) {
    if (container === undefined) {
      continue
    }
    const value = result[container]
    if (value !== null && typeof value === 'object') {
      result[container] = JSON.parse(JSON.stringify(value))
    }
  }
  return result
}

function setDotted(target: Record<string, unknown>, dotted: string, key: string, value: unknown): void {
  let cursor: unknown = target
  for (const part of dotted.split('.').slice(0, -1)) {
    if (Array.isArray(cursor)) {
      cursor = cursor[Number(part)]
    } else if (isRecord(cursor)) {
      cursor = cursor[part]
    } else {
      return
    }
  }
  if (isRecord(cursor)) {
    cursor[key] = value
  }
}

/**
 * The frame row after an `update_frame` broadcast: `incoming` over
 * `existing`, except that a secret leaf the broadcast left out of a block it
 * did send (the backend strips them — websocket_frame_payload) keeps the
 * value the browser already holds. Without this a broadcast that carried
 * `agent` would have wiped the shared secret from the form; without the
 * block at all the workspace never learnt `agent.agentVersion` after a
 * Remote upgrade until a page reload.
 */
export function mergeBroadcastFrame<T extends object>(existing: T | null | undefined, incoming: Partial<T>): T {
  const result: Record<string, unknown> = { ...(existing ?? {}), ...incoming }
  for (const path of SECRET_PATHS) {
    const container = path[0]
    if (container === undefined || path.length < 2 || !(container in incoming)) {
      continue
    }
    if (result[container] !== null && typeof result[container] === 'object') {
      result[container] = JSON.parse(JSON.stringify(result[container]))
    }
    for (const { container: from, key, dotted } of walk(existing, path)) {
      const value = from[key]
      if (value === null || value === undefined || value === '') {
        continue
      }
      let target: unknown = result
      for (const part of dotted.split('.').slice(0, -1)) {
        target = Array.isArray(target) ? target[Number(part)] : isRecord(target) ? target[part] : undefined
      }
      if (isRecord(target) && !(key in target)) {
        target[key] = value
      }
    }
  }
  return result as T
}

/**
 * `snapshot` with every secret whose stored fingerprint matches the frame's
 * current fingerprint filled in from `current`. Snapshots without
 * fingerprints (none, or a backend that predates them) come back unchanged.
 */
export function restoreDeployedSecrets<T extends Record<string, unknown>>(
  snapshot: T | null | undefined,
  current: Partial<FrameType> | null | undefined
): T | null | undefined {
  if (!isRecord(snapshot) || !(FINGERPRINTS_KEY in snapshot)) {
    return snapshot
  }
  const stored = fingerprintsOf(snapshot)
  const live = fingerprintsOf(current)
  const result = copyTouched(snapshot)
  delete result[FINGERPRINTS_KEY]
  for (const path of SECRET_PATHS) {
    for (const { container, key, dotted } of walk(current, path)) {
      const value = container[key]
      if (value === null || value === undefined || value === '') {
        continue
      }
      if (!stored[dotted] || stored[dotted] !== live[dotted]) {
        continue
      }
      setDotted(result, dotted, key, value)
    }
  }
  return result as T
}
