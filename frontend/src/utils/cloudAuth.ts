import { normalizeFrameosAuthProviderUrl } from '@frameos-cloud/auth-client'
import type { CloudAuthPublicStatus } from '../types'

export const defaultCloudAuthPublicStatus: CloudAuthPublicStatus = {
  provider_enabled: false,
  provider_url: null,
  status: 'provider_disabled',
  local_fallback_enabled: true,
}

export function normalizeCloudAuthPublicStatus(value: Partial<CloudAuthPublicStatus> | null): CloudAuthPublicStatus {
  if (!value?.provider_enabled) {
    return { ...defaultCloudAuthPublicStatus, local_fallback_enabled: value?.local_fallback_enabled ?? true }
  }

  try {
    const provider = normalizeFrameosAuthProviderUrl(value.provider_url)
    return {
      provider_enabled: !provider.disabled,
      provider_url: provider.disabled ? null : provider.providerUrl,
      status: value.status ?? 'disconnected',
      local_fallback_enabled: value.local_fallback_enabled ?? true,
    }
  } catch {
    return {
      provider_enabled: true,
      provider_url: value.provider_url ?? null,
      status: value.status ?? 'disconnected',
      local_fallback_enabled: value.local_fallback_enabled ?? true,
    }
  }
}
