// The cloud's account pages, as the settings side panel lists them.
//
// Each is its own route — /account/<key> — and its own scene of the
// shared SPA (CloudSettings.tsx draws the one whose key is in the URL). They
// used to be Next.js pages under /account with a tab bar; the keys here are
// what the cloud redirects those old URLs onto (cloud/apps/auth-web
// src/lib/env.ts getAccountPath), so a key is a public URL segment: rename
// one only with a redirect from the old name.
//
// Pure data on purpose: the cloud's own tests import this file to keep its
// redirect table in step, and the cloud's strict type program must not have
// to compile the page components to read a list of keys.

export type AccountPageKey =
  | 'backends'
  | 'services'
  | 'ssh'
  | 'usage'
  | 'backups'
  | 'activity'
  | 'security'
  | 'developer'

export interface AccountPage {
  key: AccountPageKey
  /** The side panel entry. */
  label: string
  /** The page's heading. */
  title: string
  /** One sentence under the heading. */
  description: string
}

export const accountPages: readonly AccountPage[] = [
  {
    key: 'backends',
    label: 'Backends',
    title: 'Linked backends',
    description:
      'Self-managed frames and backends that link to your account for cloud services like login and backups. Cloud-managed frames live under Frames.',
  },
  {
    key: 'services',
    label: 'Service keys',
    title: 'Service API keys',
    description:
      'Keys the apps on your frames use: Unsplash photos, Immich albums, Home Assistant sensors, OpenAI images and text. Saved keys reach your cloud-managed frames on their next check-in.',
  },
  {
    key: 'ssh',
    label: 'SSH keys',
    title: 'SSH keys',
    description:
      'Public keys the SD card builder installs on new Linux frames, so you can log in as root over SSH. The cloud stores public keys only.',
  },
  {
    key: 'usage',
    label: 'Usage',
    title: 'Usage',
    description: 'Storage, frames and AI usage against the limits of your plan.',
  },
  {
    key: 'backups',
    label: 'Backups',
    title: 'Cloud backups',
    description:
      'Frame configurations and scenes your linked backends send here. Each backup is encrypted with your backup key before upload, so we only ever hold ciphertext.',
  },
  {
    key: 'activity',
    label: 'Activity',
    title: 'Recent activity',
    description:
      'Everything recorded on this account: sign-ins, device links, frame changes, backups and store activity.',
  },
  {
    key: 'security',
    label: 'Security',
    title: 'Security',
    description: 'Your password, signed-in sessions, two-factor authentication and your data.',
  },
  {
    key: 'developer',
    label: 'Developer',
    title: 'Developer',
    description: 'API tokens and the MCP server, for scripts and AI agents that drive your frames and scenes.',
  },
]

/** The page the bare /account lands on: the first in the list. */
export const defaultAccountPageKey: AccountPageKey = 'backends'

export function isAccountPageKey(value: string | null | undefined): value is AccountPageKey {
  return typeof value === 'string' && accountPages.some((page) => page.key === value)
}

export function accountPage(key: AccountPageKey): AccountPage {
  return (
    accountPages.find((page) => page.key === key) ?? accountPages.find((page) => page.key === defaultAccountPageKey)!
  )
}
