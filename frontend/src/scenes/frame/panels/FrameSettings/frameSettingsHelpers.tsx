import { useState } from 'react'
import copy from 'copy-to-clipboard'
import { A } from 'kea-router'
import { ExclamationTriangleIcon } from '@heroicons/react/24/solid'
import { Button } from '../../../../components/Button'
import { Field } from '../../../../components/Field'
import { getCertificateValidityInfo, getFrameCertificateStatus } from '../../../../utils/certificates'
import type { FrameMountpointConfig, FrameType } from '../../../../types'
import type { FrameOSUpgradeStatus } from './frameAdminUpgradeLogic'

/** Small pieces the Settings sections share. No gating lives here. */

export function getCertificateHint(certificateName: string, value?: string): JSX.Element | undefined {
  const validityInfo = getCertificateValidityInfo(value)

  if (!validityInfo) {
    return undefined
  }

  const colorClass =
    validityInfo.severity === 'expired'
      ? 'text-red-300'
      : validityInfo.severity === 'expiring'
      ? 'text-yellow-300'
      : 'frame-tool-muted'

  return (
    <div className={colorClass} title={validityInfo.exactDateTime}>
      {(validityInfo.severity === 'expired' || validityInfo.severity === 'expiring') && (
        <ExclamationTriangleIcon
          className={
            validityInfo.severity === 'expired'
              ? 'inline-block mr-1 h-4 w-4 text-red-300'
              : 'inline-block mr-1 h-4 w-4 text-yellow-300'
          }
        />
      )}
      {certificateName} {validityInfo.humanText}
      {validityInfo.severity === 'expired' || validityInfo.severity === 'expiring'
        ? ' - Please regenerate and redeploy.'
        : ''}
    </div>
  )
}

export function CertificateTriangle({
  frame,
  frameForm,
}: {
  frame: FrameType | null
  frameForm: Partial<FrameType> | null
}): JSX.Element | null {
  const certificateStatus = getFrameCertificateStatus({
    https_proxy: {
      client_ca_cert_not_valid_after:
        frameForm?.https_proxy?.client_ca_cert_not_valid_after ?? frame?.https_proxy?.client_ca_cert_not_valid_after,
      server_cert_not_valid_after:
        frameForm?.https_proxy?.server_cert_not_valid_after ?? frame?.https_proxy?.server_cert_not_valid_after,
    },
  })
  if (certificateStatus !== 'expired' && certificateStatus !== 'expiring') {
    return null
  }
  return (
    <span
      title={
        certificateStatus === 'expired'
          ? 'HTTPS certificates have expired. Please regenerate and redeploy.'
          : 'HTTPS certificates are expiring soon. Please regenerate and redeploy.'
      }
    >
      <ExclamationTriangleIcon
        className={certificateStatus === 'expired' ? 'h-4 w-4 text-red-300' : 'h-4 w-4 text-yellow-300'}
      />
    </span>
  )
}

export function newMountpoint(): FrameMountpointConfig {
  return {
    enabled: true,
    source: '',
    target: '',
    username: '',
    password: '',
    domain: '',
    options: 'vers=3.0',
  }
}

export function scrollToFrameHttpApiSection(e: React.MouseEvent): void {
  if (typeof document === 'undefined') {
    return
  }
  const frameSettingsDiv =
    e.target instanceof HTMLElement
      ? e.target.closest('#panel-settings-div')
      : document.getElementById('panel-settings-div')
  const scrollingOuterDiv = frameSettingsDiv?.parentElement
  const httpApiSection = frameSettingsDiv?.querySelector('#frame-http-proxy-section')
  if (scrollingOuterDiv && httpApiSection) {
    const offset = httpApiSection.getBoundingClientRect().top - scrollingOuterDiv.getBoundingClientRect().top
    scrollingOuterDiv.scrollTo({ top: offset, behavior: 'smooth' }) // works in frame settings panel
    scrollingOuterDiv?.parentElement?.scrollTo({ top: offset, behavior: 'smooth' }) // works in sd card modal
  }
}

export function VirtualFrameUrlRow({ label, url }: { label: string; url: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <Field name="_noop" label={label}>
      <div className="flex w-full items-start gap-2">
        <A
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          className="frameos-link min-w-0 flex-1 break-all font-mono text-xs leading-5 hover:underline"
        >
          {url}
        </A>
        <Button
          color="secondary"
          size="small"
          onClick={() => {
            copy(url)
            setCopied(true)
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </Field>
  )
}

export function displayVersion(version?: string | null): string {
  const trimmed = version?.trim()
  return trimmed && trimmed !== 'unknown' ? trimmed : 'Unknown'
}

export function latestUpgradeVersion(status: FrameOSUpgradeStatus | null): string | undefined {
  return status?.latest_version || status?.latest_release?.version
}

/** The "Release build" row of the upgrade card. Debian and Ubuntu hosts see
 * the distro release because it decides which precompiled binary they get
 * (bookworm vs trixie, and bullseye gets none). A Buildroot image is not
 * Debian and has no apt, so it sees only the architecture; the slug it
 * downloads moves into the hint so it stops reading as the OS. */
export function upgradeBuildLabel(status: FrameOSUpgradeStatus | null): { label: string; hint?: string } {
  const target = status?.target?.trim()
  if (!target) {
    return { label: 'Unknown' }
  }
  const host = status?.host
  if (host?.id === 'buildroot') {
    const arch = host.arch?.trim() || target.split('-').pop() || target
    return {
      label: arch,
      hint: `This FrameOS system image installs the ${target} release build. It is not a Debian system and has no package manager.`,
    }
  }
  return { label: target }
}

/** The "Operating system" row: PRETTY_NAME from the device's os-release, or
 * nothing on releases that predate the `host` field. */
export function upgradeHostLabel(status: FrameOSUpgradeStatus | null): string | undefined {
  const host = status?.host
  if (!host) {
    return undefined
  }
  const name = host.name?.trim()
  if (!name) {
    return undefined
  }
  return host.id === 'buildroot' && host.version?.trim() ? `${name} ${host.version.trim()}` : name
}

export function upgradeStatusColor(status: string | undefined) {
  return status === 'failed'
    ? 'red'
    : status === 'success'
    ? 'teal'
    : status === 'reboot_required'
    ? 'orange'
    : status === 'running' || status === 'starting'
    ? 'primary'
    : status === 'dry_run'
    ? 'yellow'
    : 'gray'
}

export function upgradeStatusLabel(status: string | undefined): string {
  return status ? status.replace(/_/g, ' ') : 'idle'
}

export function hasSettingsFieldValue(value: unknown): boolean {
  return value !== undefined && value !== null && (typeof value === 'string' ? value.trim() !== '' : true)
}

export function settingsInputValue(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}
