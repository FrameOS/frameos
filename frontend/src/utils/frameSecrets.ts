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
// walks a list.
const SECRET_PATHS: readonly (readonly string[])[] = [
  ['ssh_pass'],
  ['server_api_key'],
  ['frame_access_key'],
  ['https_proxy', 'certs', 'server_key'],
  ['agent', 'agentSharedSecret'],
  ['frame_admin_auth', 'pass'],
  ['mountpoints', 'items', '*', 'password'],
]

const FINGERPRINTS_KEY = 'secret_fingerprints'

type Leaf = { container: Record<string, unknown>; key: string; dotted: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function* walk(value: unknown, path: readonly string[], prefix = ''): Generator<Leaf> {
  const [head, ...rest] = path
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
    if (container in result && result[container] !== null && typeof result[container] === 'object') {
      result[container] = JSON.parse(JSON.stringify(result[container]))
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
