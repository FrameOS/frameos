import { kea, key, path, props } from 'kea'

import type { frameSettingsLogicType } from './frameSettingsLogicType'
import { loaders } from 'kea-loaders'
import { apiFetch } from '../../../../utils/apiFetch'
import { downloadZip } from '../../../../utils/downloadJson'
import type { FrameBuildrootConfig } from '../../../../types'

export type DownloadSdImagePayload = { buildroot?: FrameBuildrootConfig }

function buildSdImageDownloadPath(frameId: number, buildroot?: FrameBuildrootConfig): string {
  const params = new URLSearchParams()
  if (buildroot?.platform) {
    params.set('platform', buildroot.platform)
  }
  if (buildroot?.wifiVariant) {
    params.set('wifiVariant', buildroot.wifiVariant)
  }
  if (buildroot?.imageArtifactName) {
    params.set('imageArtifactName', buildroot.imageArtifactName)
  }
  if (buildroot?.buildrootRef) {
    params.set('buildrootRef', buildroot.buildrootRef)
  }
  if (buildroot?.configFragments) {
    params.set('configFragments', buildroot.configFragments)
  }
  const query = params.toString()
  return `/api/frames/${frameId}/download_sd_image${query ? `?${query}` : ''}`
}

export const frameSettingsLogic = kea<frameSettingsLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'FrameSettings', 'frameSettingsLogic']),
  props({} as { frameId: number }),
  key((props) => props.frameId),
  loaders(({ props }) => ({
    buildCache: [
      false,
      {
        clearBuildCache: async () => {
          if (confirm('Are you sure you want to clear the build cache?')) {
            try {
              await apiFetch(`/api/frames/${props.frameId}/clear_build_cache`, { method: 'POST' })
            } catch (error) {
              console.error(error)
            }
          }
          return false
        },
      },
    ],
    buildZip: [
      false,
      {
        downloadBuildZip: async () => {
          const response = await apiFetch(`/api/frames/${props.frameId}/download_build_zip`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/zip' },
          })
          if (!response.ok) {
            throw new Error('Failed to download build zip')
          }
          downloadZip(await response.blob(), `frame_${props.frameId}_build.zip`)
          return false
        },
      },
    ],
    cSourceZip: [
      false,
      {
        downloadCSourceZip: async () => {
          const response = await apiFetch(`/api/frames/${props.frameId}/download_c_source_zip`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/zip' },
          })
          if (!response.ok) {
            throw new Error('Failed to generate C sources .zip')
          }
          downloadZip(await response.blob(), `frame_${props.frameId}_c_source.zip`)
          return false
        },
      },
    ],
    binaryZip: [
      false,
      {
        downloadBinaryZip: async () => {
          const response = await apiFetch(`/api/frames/${props.frameId}/download_binary_zip`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/zip' },
          })
          if (!response.ok) {
            throw new Error('Failed to download built binary .zip')
          }
          downloadZip(await response.blob(), `frame_${props.frameId}_binary.zip`)
          return false
        },
      },
    ],
    sdImage: [
      false,
      {
        downloadSdImage: async ({ buildroot }: DownloadSdImagePayload = {}) => {
          const response = await apiFetch(buildSdImageDownloadPath(props.frameId, buildroot))
          if (!response.ok) {
            const payload = await response.json().catch(() => ({}))
            throw new Error(payload.detail || 'Failed to download SD card image')
          }
          const disposition = response.headers.get('Content-Disposition') || ''
          const filename = disposition.match(/filename="([^"]+)"/)?.[1] || `frame_${props.frameId}_sdcard.img.xz`
          downloadZip(await response.blob(), filename)
          return false
        },
      },
    ],
  })),
])
