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
