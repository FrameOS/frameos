import { actions, afterMount, kea, listeners, path, reducers } from 'kea'
import { loaders } from 'kea-loaders'
import QRCode from 'qrcode'

import type { cloudSettingsLogicType } from './cloudSettingsLogicType'
import type { CloudAuthStatus } from '../../types'
import { urls } from '../../urls'
import { apiFetch } from '../../utils/apiFetch'
import { defaultCloudAuthPublicStatus, normalizeCloudAuthPublicStatus } from '../../utils/cloudAuth'
import { showWorkingMessage } from '../../utils/workingMessage'

export const defaultCloudAuthStatus: CloudAuthStatus = {
  ...defaultCloudAuthPublicStatus,
  link: null,
  memberships: [],
  current_user_cloud_identities: [],
}

async function responseErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json()
    if (typeof payload?.detail === 'string') {
      return payload.detail
    }
    if (typeof payload?.error === 'string') {
      return payload.error
    }
  } catch {
    // Use fallback below.
  }
  return fallback
}

function normalizeCloudAuthStatus(payload: Partial<CloudAuthStatus> | null): CloudAuthStatus {
  const publicStatus = normalizeCloudAuthPublicStatus(payload)
  return {
    ...defaultCloudAuthStatus,
    ...payload,
    ...publicStatus,
    link: payload?.link ?? null,
    memberships: payload?.memberships ?? [],
    current_user_cloud_identities: payload?.current_user_cloud_identities ?? [],
  }
}

async function verificationQrCodeDataUrl(cloudAuthStatus: CloudAuthStatus): Promise<string | null> {
  const verificationUrl = cloudAuthStatus.link?.verification_uri_complete
  return verificationUrl
    ? await QRCode.toDataURL(verificationUrl, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 176,
      })
    : null
}

async function cloudAuthRequest(path: string, options: RequestInit = {}, fallback: string): Promise<CloudAuthStatus> {
  const response = await apiFetch(path, options)
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, fallback))
  }
  return normalizeCloudAuthStatus((await response.json()) as Partial<CloudAuthStatus>)
}

function verificationUrlWithReturnTo(verificationUrl: string): string {
  try {
    const url = new URL(verificationUrl)
    const returnUrl = new URL(`${urls.settings()}#settings-cloud`, window.location.origin)
    url.searchParams.set('return_to', returnUrl.toString())
    return url.toString()
  } catch {
    return verificationUrl
  }
}

let reservedVerificationWindow: Window | null = null

function reserveVerificationWindow(): void {
  try {
    reservedVerificationWindow = window.open('about:blank', 'frameos-cloud-verification')
    if (reservedVerificationWindow) {
      reservedVerificationWindow.opener = null
    }
  } catch {
    reservedVerificationWindow = null
  }
}

function closeReservedVerificationWindow(): void {
  const reservedWindow = reservedVerificationWindow
  reservedVerificationWindow = null
  try {
    if (reservedWindow && !reservedWindow.closed) {
      reservedWindow.close()
    }
  } catch {
    // The tab may already have navigated.
  }
}

function linkIsActive(cloudAuthStatus: CloudAuthStatus): boolean {
  if (cloudAuthStatus.status !== 'connecting') {
    return false
  }
  const expiresAt = cloudAuthStatus.link?.expires_at ? Date.parse(cloudAuthStatus.link.expires_at) : null
  return !expiresAt || !Number.isFinite(expiresAt) || expiresAt > Date.now()
}

function openVerificationUrl(verificationUrl: string | null | undefined): void {
  if (!verificationUrl) {
    closeReservedVerificationWindow()
    return
  }
  const url = verificationUrlWithReturnTo(verificationUrl)
  const reservedWindow = reservedVerificationWindow
  reservedVerificationWindow = null
  try {
    if (reservedWindow && !reservedWindow.closed) {
      reservedWindow.opener = null
      reservedWindow.location.href = url
      reservedWindow.focus()
      return
    }
  } catch {
    // Fall back to opening the URL below.
  }
  const opened = window.open(url, '_blank', 'noopener,noreferrer')
  if (!opened) {
    window.location.href = url
  }
}

export const cloudSettingsLogic = kea<cloudSettingsLogicType>([
  path(['src', 'scenes', 'settings', 'cloudSettingsLogic']),
  actions({
    beginBackendLink: true,
    setCloudNow: (now: number) => ({ now }),
    setBackendLinkPolling: (polling: boolean) => ({ polling }),
    setPendingLocalFallbackEnabled: (enabled: boolean | null) => ({ enabled }),
    setVerificationQrCodeDataUrl: (dataUrl: string | null) => ({ dataUrl }),
    setManualSetupOpen: (open: boolean) => ({ open }),
    openBackendLinkVerification: (verificationUrl: string | null | undefined) => ({ verificationUrl }),
  }),
  reducers({
    cloudNow: [
      Date.now(),
      {
        setCloudNow: (_, { now }) => now,
      },
    ],
    backendLinkPolling: [
      false,
      {
        setBackendLinkPolling: (_, { polling }) => polling,
      },
    ],
    pendingLocalFallbackEnabled: [
      null as boolean | null,
      {
        setPendingLocalFallbackEnabled: (_, { enabled }) => enabled,
      },
    ],
    verificationQrCodeDataUrl: [
      null as string | null,
      {
        setVerificationQrCodeDataUrl: (_, { dataUrl }) => dataUrl,
      },
    ],
    manualSetupOpen: [
      false,
      {
        setManualSetupOpen: (_, { open }) => open,
      },
    ],
  }),
  loaders(() => ({
    cloudAuthStatus: [
      defaultCloudAuthStatus as any,
      {
        loadCloudAuthStatus: async (): Promise<any> => {
          return cloudAuthRequest('/api/cloud-auth/status', {}, 'Failed to load FrameOS Cloud status')
        },
        startBackendLink: async (): Promise<any> => {
          const workingMessage = showWorkingMessage('Starting FrameOS Cloud linking...')
          try {
            const status = await cloudAuthRequest(
              '/api/cloud-auth/backend-link/start',
              { method: 'POST' },
              'Failed to start FrameOS Cloud linking'
            )
            workingMessage.success('FrameOS Cloud linking started')
            return status
          } catch (error) {
            workingMessage.error(error instanceof Error ? error.message : 'Failed to start FrameOS Cloud linking')
            throw error
          }
        },
        pollBackendLink: async (): Promise<any> => {
          return cloudAuthRequest(
            '/api/cloud-auth/backend-link/poll',
            { method: 'POST' },
            'Failed to check FrameOS Cloud linking'
          )
        },
        syncBackendLink: async (): Promise<any> => {
          const workingMessage = showWorkingMessage('Syncing FrameOS Cloud...')
          try {
            const status = await cloudAuthRequest(
              '/api/cloud-auth/backend-link/sync',
              { method: 'POST' },
              'Failed to sync FrameOS Cloud'
            )
            workingMessage.success('FrameOS Cloud synced')
            return status
          } catch (error) {
            workingMessage.error(error instanceof Error ? error.message : 'Failed to sync FrameOS Cloud')
            throw error
          }
        },
        rotateBackendToken: async (): Promise<any> => {
          const workingMessage = showWorkingMessage('Rotating FrameOS Cloud token...')
          try {
            const status = await cloudAuthRequest(
              '/api/cloud-auth/backend-link/rotate-token',
              { method: 'POST' },
              'Failed to rotate FrameOS Cloud token'
            )
            workingMessage.success('FrameOS Cloud token rotated')
            return status
          } catch (error) {
            workingMessage.error(error instanceof Error ? error.message : 'Failed to rotate FrameOS Cloud token')
            throw error
          }
        },
        disconnectBackendLink: async (): Promise<any> => {
          const workingMessage = showWorkingMessage('Disconnecting FrameOS Cloud...')
          try {
            const status = await cloudAuthRequest(
              '/api/cloud-auth/backend-link',
              { method: 'DELETE' },
              'Failed to disconnect FrameOS Cloud'
            )
            workingMessage.success('FrameOS Cloud disconnected')
            return status
          } catch (error) {
            workingMessage.error(error instanceof Error ? error.message : 'Failed to disconnect FrameOS Cloud')
            throw error
          }
        },
        setLocalFallbackEnabled: async (enabled: boolean): Promise<any> => {
          const status = await cloudAuthRequest(
            '/api/cloud-auth/local-fallback',
            {
              method: 'POST',
              body: JSON.stringify({ enabled }),
              headers: { 'Content-Type': 'application/json' },
            },
            'Failed to update local fallback'
          )
          return status
        },
      },
    ],
  })),
  listeners(({ actions }) => ({
    beginBackendLink: () => {
      reserveVerificationWindow()
      actions.startBackendLink()
    },
    loadCloudAuthStatusSuccess: async ({ cloudAuthStatus }, breakpoint) => {
      const active = linkIsActive(cloudAuthStatus)
      actions.setBackendLinkPolling(active)
      actions.setVerificationQrCodeDataUrl(await verificationQrCodeDataUrl(cloudAuthStatus))
      if (active) {
        await breakpoint(Math.max(1, cloudAuthStatus.link?.interval_seconds ?? 5) * 1000)
        actions.pollBackendLink()
      }
    },
    startBackendLinkSuccess: async ({ cloudAuthStatus }, breakpoint) => {
      const active = linkIsActive(cloudAuthStatus)
      actions.setManualSetupOpen(false)
      actions.setBackendLinkPolling(active)
      actions.setVerificationQrCodeDataUrl(await verificationQrCodeDataUrl(cloudAuthStatus))
      if (active) {
        openVerificationUrl(cloudAuthStatus.link?.verification_uri_complete ?? cloudAuthStatus.link?.verification_uri)
      } else {
        closeReservedVerificationWindow()
      }
      if (active) {
        await breakpoint(Math.max(1, cloudAuthStatus.link?.interval_seconds ?? 5) * 1000)
        actions.pollBackendLink()
      }
    },
    pollBackendLinkSuccess: async ({ cloudAuthStatus }, breakpoint) => {
      const active = linkIsActive(cloudAuthStatus)
      actions.setBackendLinkPolling(active)
      actions.setVerificationQrCodeDataUrl(await verificationQrCodeDataUrl(cloudAuthStatus))
      if (active) {
        await breakpoint(Math.max(1, cloudAuthStatus.link?.interval_seconds ?? 5) * 1000)
        actions.pollBackendLink()
      }
    },
    startBackendLinkFailure: () => {
      closeReservedVerificationWindow()
    },
    syncBackendLinkSuccess: async ({ cloudAuthStatus }) => {
      actions.setVerificationQrCodeDataUrl(await verificationQrCodeDataUrl(cloudAuthStatus))
    },
    rotateBackendTokenSuccess: async ({ cloudAuthStatus }) => {
      actions.setVerificationQrCodeDataUrl(await verificationQrCodeDataUrl(cloudAuthStatus))
    },
    disconnectBackendLinkSuccess: () => {
      actions.setManualSetupOpen(false)
      actions.setVerificationQrCodeDataUrl(null)
    },
    openBackendLinkVerification: ({ verificationUrl }) => {
      openVerificationUrl(verificationUrl)
    },
    setLocalFallbackEnabled: (enabled) => {
      actions.setPendingLocalFallbackEnabled(enabled)
    },
    setLocalFallbackEnabledSuccess: () => {
      actions.setPendingLocalFallbackEnabled(null)
    },
    setLocalFallbackEnabledFailure: () => {
      actions.setPendingLocalFallbackEnabled(null)
    },
  })),
  afterMount(({ actions }) => {
    actions.loadCloudAuthStatus()
    const interval = window.setInterval(() => actions.setCloudNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }),
])
