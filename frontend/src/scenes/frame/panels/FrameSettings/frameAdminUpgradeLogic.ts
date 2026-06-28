import { actions, afterMount, beforeUnmount, kea, listeners, path, reducers, selectors } from 'kea'
import { loaders } from 'kea-loaders'

import { apiFetch } from '../../../../utils/apiFetch'

import type { frameAdminUpgradeLogicType } from './frameAdminUpgradeLogicType'

export type FrameOSUpgradeStatusValue =
  | 'idle'
  | 'starting'
  | 'running'
  | 'dry_run'
  | 'success'
  | 'reboot_required'
  | 'failed'
  | 'up_to_date'

export interface FrameOSUpgradeRelease {
  version?: string
  tag_name?: string
  target?: string
  asset_name?: string
  asset_url?: string
  html_url?: string
}

export interface FrameOSUpgradeStatus {
  status?: FrameOSUpgradeStatusValue | string
  message?: string
  current_version?: string
  compiled_version?: string
  target?: string
  target_error?: string
  latest_version?: string
  latest_error?: string
  latest_release?: FrameOSUpgradeRelease
  update_available?: boolean
  updated_at?: string
  started_at?: string
  finished_at?: string
  log_path?: string
  release_dir?: string
  remote_release_dir?: string
  exit_code?: number
}

const UPGRADE_POLL_MS = 3000
const UPGRADE_RELOAD_MS = 1200
const UPGRADE_PENDING_KEY = 'frameos.upgrade.pending'
const UPGRADE_RELOAD_KEY = 'frameos.upgrade.reloaded'

function browserSessionStorage(): Storage | null {
  if (typeof window === 'undefined') {
    return null
  }
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

function readPendingUpgrade(): boolean {
  return browserSessionStorage()?.getItem(UPGRADE_PENDING_KEY) === '1'
}

function setPendingUpgrade(pending: boolean): void {
  const storage = browserSessionStorage()
  if (!storage) {
    return
  }
  if (pending) {
    storage.setItem(UPGRADE_PENDING_KEY, '1')
  } else {
    storage.removeItem(UPGRADE_PENDING_KEY)
  }
}

function alreadyReloadedFor(status: FrameOSUpgradeStatus): boolean {
  const storage = browserSessionStorage()
  if (!storage) {
    return false
  }
  const marker = status.updated_at || status.finished_at || status.latest_version || status.status || 'unknown'
  if (storage.getItem(UPGRADE_RELOAD_KEY) === marker) {
    return true
  }
  storage.setItem(UPGRADE_RELOAD_KEY, marker)
  return false
}

function statusIsActive(status?: FrameOSUpgradeStatus | null): boolean {
  return status?.status === 'starting' || status?.status === 'running'
}

function statusShouldReload(status?: FrameOSUpgradeStatus | null): boolean {
  return status?.status === 'success' || status?.status === 'reboot_required'
}

async function responseErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json()
    if (typeof payload?.detail === 'string' && payload.detail.trim()) {
      return payload.detail
    }
    if (typeof payload?.message === 'string' && payload.message.trim()) {
      return payload.message
    }
  } catch {
    // Keep the fallback when the server returned a non-JSON error.
  }
  return fallback
}

async function loadUpgradeStatus(checkLatest = false): Promise<FrameOSUpgradeStatus> {
  const response = await apiFetch(`/api/upgrade/status${checkLatest ? '?check=1' : ''}`)
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, 'Failed to load upgrade status'))
  }
  return (await response.json()) as FrameOSUpgradeStatus
}

async function postUpgrade(body: Record<string, unknown>): Promise<FrameOSUpgradeStatus> {
  const response = await apiFetch('/api/upgrade', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, 'Failed to start upgrade'))
  }
  return (await response.json()) as FrameOSUpgradeStatus
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

export const frameAdminUpgradeLogic = kea<frameAdminUpgradeLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'FrameSettings', 'frameAdminUpgradeLogic']),
  actions({
    confirmStartUpgrade: true,
    scheduleUpgradeStatusPoll: (delayMs: number) => ({ delayMs }),
    setUpgradePolling: (polling: boolean) => ({ polling }),
    markUpgradeRunningSeen: true,
    setUpgradeError: (error: string | null) => ({ error }),
    reloadAfterUpgrade: true,
  }),
  loaders(() => ({
    upgradeStatus: [
      null as FrameOSUpgradeStatus | null,
      {
        loadUpgradeStatus: async () => loadUpgradeStatus(false),
        checkUpgradeStatus: async () => loadUpgradeStatus(true),
        dryRunUpgrade: async () => postUpgrade({ dry_run: true }),
        startUpgrade: async () => postUpgrade({}),
      },
    ],
  })),
  reducers({
    isUpgradePolling: [
      false,
      {
        setUpgradePolling: (_, { polling }) => polling,
        startUpgrade: () => true,
      },
    ],
    upgradeRunningSeen: [
      false,
      {
        markUpgradeRunningSeen: () => true,
        startUpgrade: () => true,
      },
    ],
    upgradeError: [
      null as string | null,
      {
        setUpgradeError: (_, { error }) => error,
        loadUpgradeStatusSuccess: () => null,
        checkUpgradeStatusSuccess: () => null,
        dryRunUpgradeSuccess: () => null,
        startUpgradeSuccess: () => null,
      },
    ],
  }),
  selectors({
    upgradeStatusIsActive: [(s) => [s.upgradeStatus], (upgradeStatus) => statusIsActive(upgradeStatus)],
    upgradeStatusCanReload: [(s) => [s.upgradeStatus], (upgradeStatus) => statusShouldReload(upgradeStatus)],
  }),
  listeners(({ actions, values, cache }) => ({
    confirmStartUpgrade: () => {
      if (window.confirm('Upgrade FrameOS to the latest stable GitHub release?')) {
        actions.startUpgrade()
      }
    },
    startUpgrade: () => {
      setPendingUpgrade(true)
      actions.setUpgradePolling(true)
      actions.markUpgradeRunningSeen()
      actions.setUpgradeError(null)
    },
    startUpgradeSuccess: () => {
      actions.scheduleUpgradeStatusPoll(UPGRADE_POLL_MS)
    },
    startUpgradeFailure: ({ error }) => {
      actions.setUpgradePolling(false)
      actions.setUpgradeError(errorMessage(error))
    },
    dryRunUpgradeFailure: ({ error }) => {
      actions.setUpgradeError(errorMessage(error))
    },
    checkUpgradeStatusFailure: ({ error }) => {
      actions.setUpgradeError(errorMessage(error))
    },
    loadUpgradeStatusFailure: ({ error }) => {
      actions.setUpgradeError(errorMessage(error))
      if (values.isUpgradePolling || readPendingUpgrade()) {
        actions.setUpgradePolling(true)
        actions.scheduleUpgradeStatusPoll(UPGRADE_POLL_MS)
      }
    },
    loadUpgradeStatusSuccess: ({ upgradeStatus }) => {
      if (statusIsActive(upgradeStatus)) {
        actions.setUpgradePolling(true)
        actions.markUpgradeRunningSeen()
        setPendingUpgrade(true)
        actions.scheduleUpgradeStatusPoll(UPGRADE_POLL_MS)
      } else if ((values.isUpgradePolling || values.upgradeRunningSeen || readPendingUpgrade()) && upgradeStatus) {
        actions.setUpgradePolling(false)
        setPendingUpgrade(false)
        if (statusShouldReload(upgradeStatus)) {
          actions.reloadAfterUpgrade()
        }
      }
    },
    checkUpgradeStatusSuccess: ({ upgradeStatus }) => {
      if (statusIsActive(upgradeStatus)) {
        actions.setUpgradePolling(true)
        actions.markUpgradeRunningSeen()
        setPendingUpgrade(true)
        actions.scheduleUpgradeStatusPoll(UPGRADE_POLL_MS)
      }
    },
    dryRunUpgradeSuccess: ({ upgradeStatus }) => {
      if (statusIsActive(upgradeStatus)) {
        actions.setUpgradePolling(true)
        actions.markUpgradeRunningSeen()
        actions.scheduleUpgradeStatusPoll(UPGRADE_POLL_MS)
      }
    },
    scheduleUpgradeStatusPoll: ({ delayMs }) => {
      if (cache.upgradePollTimer) {
        window.clearTimeout(cache.upgradePollTimer)
      }
      cache.upgradePollTimer = window.setTimeout(() => actions.loadUpgradeStatus(), delayMs)
    },
    reloadAfterUpgrade: () => {
      const status = values.upgradeStatus
      if (status && alreadyReloadedFor(status)) {
        return
      }
      window.setTimeout(() => window.location.reload(), UPGRADE_RELOAD_MS)
    },
  })),
  afterMount(({ actions }) => {
    if (readPendingUpgrade()) {
      actions.setUpgradePolling(true)
      actions.markUpgradeRunningSeen()
    }
    actions.loadUpgradeStatus()
  }),
  beforeUnmount(({ cache }) => {
    if (cache.upgradePollTimer) {
      window.clearTimeout(cache.upgradePollTimer)
    }
  }),
])
