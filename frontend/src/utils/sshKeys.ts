import { FrameOSSettings, SSHKeyEntry } from '../types'

export const normalizeSshKeys = (
  sshKeys: FrameOSSettings['ssh_keys'] | undefined
): { keys: SSHKeyEntry[] } => {
  if (!sshKeys) {
    return { keys: [] }
  }

  if (Array.isArray(sshKeys.keys)) {
    return {
      keys: sshKeys.keys
        .map((key) => ({
          id: String(key.id ?? '').trim(),
          name: key.name,
          private: key.private,
          public: key.public,
          use_for_new_frames: !!key.use_for_new_frames,
        }))
        .filter((key) => key.id),
    }
  }

  if (sshKeys.default || sshKeys.default_public) {
    return {
      keys: [
        {
          id: 'default',
          name: 'Default',
          private: sshKeys.default,
          public: sshKeys.default_public,
          use_for_new_frames: true,
        },
      ],
    }
  }

  return { keys: [] }
}

export const getDefaultSshKeyIds = (sshKeys: FrameOSSettings['ssh_keys'] | undefined): string[] =>
  normalizeSshKeys(sshKeys).keys.filter((key) => key.use_for_new_frames).map((key) => key.id)

// OpenSSH public key line: `<type> <base64> [comment]`. The type list is
// what dropbear/OpenSSH accept in authorized_keys.
const sshPublicKeyTypes = new Set([
  'ssh-ed25519',
  'ssh-rsa',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com',
  'ssh-dss',
])

export interface ParsedSshPublicKey {
  type: string
  base64: string
  comment: string
}

export function parseSshPublicKey(value: string | undefined | null): ParsedSshPublicKey | null {
  const parts = (value ?? '').trim().split(/\s+/)
  const [type, base64, ...rest] = parts
  if (!type || !base64 || !sshPublicKeyTypes.has(type)) {
    return null
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length < 16) {
    return null
  }
  return { type, base64, comment: rest.join(' ') }
}

/**
 * The key as one canonical authorized_keys line. The comment is kept only
 * when it is plain (`user@host`-like): anything else is dropped rather than
 * risk a character the SD card's busybox config parser cannot represent.
 */
export function normalizeSshPublicKey(value: string | undefined | null): string | null {
  const parsed = parseSshPublicKey(value)
  if (!parsed) {
    return null
  }
  const comment = /^[A-Za-z0-9@._+-]{1,64}$/.test(parsed.comment) ? parsed.comment : ''
  return comment ? `${parsed.type} ${parsed.base64} ${comment}` : `${parsed.type} ${parsed.base64}`
}

/** "ed25519 · …3kQd" — enough to tell two keys apart in a list. */
export function describeSshPublicKey(value: string | undefined | null): string {
  const parsed = parseSshPublicKey(value)
  if (!parsed) {
    return value?.trim() ? 'not a valid public key' : 'no public key'
  }
  const kind = parsed.type.replace(/^ssh-|^sk-ssh-|@openssh\.com$/g, '').replace('ecdsa-sha2-', 'ecdsa ')
  const tail = parsed.base64.replace(/=+$/, '').slice(-8)
  return parsed.comment ? `${kind} · …${tail} · ${parsed.comment}` : `${kind} · …${tail}`
}
