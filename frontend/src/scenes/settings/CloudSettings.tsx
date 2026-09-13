import clsx from 'clsx'
import { useActions, useValues } from 'kea'
import { Form } from 'kea-forms'
import { PencilSquareIcon } from '@heroicons/react/24/solid'
import type { ReactNode } from 'react'

import { Box } from '../../components/Box'
import { Button } from '../../components/Button'
import { confirmDialog } from '../../utils/confirmDialogLogic'
import { Field } from '../../components/Field'
import { H6 } from '../../components/H6'
import { Label } from '../../components/Label'
import { Spinner } from '../../components/Spinner'
import { Switch } from '../../components/Switch'
import { Tag } from '../../components/Tag'
import { TextInput } from '../../components/TextInput'
import { Tooltip } from '../../components/Tooltip'
import { isInFrameAdminMode } from '../../utils/frameAdmin'
import { scrollToFrameSettingsSection } from '../frame/panels/FrameSettings/frameSettingsHelpers'
import { inHassioIngress } from '../../utils/inHassioIngress'
import { availableCloudFeatures, cloudLogic } from './cloudLogic'
import type { CloudStatus } from '../../types'

function pollErrorMessage(pollError: string): string {
  switch (pollError) {
    case 'expired':
    case 'expired_token':
      return 'The link code expired before it was approved. Try connecting again.'
    case 'access_denied':
      return 'The link request was denied in FrameOS Cloud.'
    case 'network_error':
      return 'Could not reach the FrameOS Cloud server. Check the URL and your network.'
    default:
      return `Connection failed: ${pollError}`
  }
}

function formatCloudBytes(size: number): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex++
  }
  return `${unitIndex === 0 ? size : Number(size.toFixed(1))} ${units[unitIndex]}`
}

function expiresInLabel(expiresAt: string | null): string | null {
  if (!expiresAt) {
    return null
  }
  const secondsLeft = Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000)
  if (secondsLeft <= 0) {
    return 'expired'
  }
  if (secondsLeft < 60) {
    return `expires in ${secondsLeft}s`
  }
  return `expires in ${Math.ceil(secondsLeft / 60)} min`
}

/**
 * What the link actually means, in a sentence, on the frame's own admin page.
 *
 * A frame can be linked to a cloud account without being driven by it, and the
 * box used to say only "Connected" — so approving a link on the phone and then
 * finding the frame unchanged on cloud.frameos.net looked like a failure. This
 * row names the two states apart and says what each one gives you.
 */
function FrameCloudStatusRow({
  cloudStatus,
  providerHost,
}: {
  cloudStatus: CloudStatus | null
  providerHost: string
}): JSX.Element {
  const managed = cloudStatus?.mode === 'managed'
  return (
    <div className="space-y-1 @md:flex @md:items-start @md:gap-2">
      <div className="@md:w-1/3 @md:shrink-0">
        <Label>Cloud status</Label>
      </div>
      <div className="w-full space-y-1 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Tag color={managed ? 'teal' : 'gray'}>{managed ? 'Managed from the cloud' : 'Linked, not managed'}</Tag>
          <Tooltip
            title={
              managed
                ? `This frame answers to ${providerHost}: scenes, settings and reboots can come from there, and your cloud scene library is available on this page.`
                : `Nothing on ${providerHost} can change what this frame shows. The link signs you in and gives this page your cloud scene library; the frame is still driven from here.`
            }
          />
        </div>
        {cloudStatus?.managed_enroll_error ? (
          <div className="text-red-500">
            The last attempt to hand this frame to FrameOS Cloud failed: {cloudStatus.managed_enroll_error}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/**
 * One on/off feature of a live link, with the sentence that says what it does.
 *
 * `unavailableReason` replaces the description when the grant behind the
 * switch is missing: the switch is shown disabled rather than hidden, because
 * "where did cloud login go" is the question the old box kept raising.
 */
function CloudFeatureSwitch({
  label,
  description,
  value,
  onChange,
  disabled,
  busy,
  nested,
  unavailableReason,
  unavailableNode,
  children,
}: {
  label: string
  description: string
  value: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
  busy?: boolean
  nested?: boolean
  unavailableReason?: string
  /** Same slot as `unavailableReason`, when the blocker needs a link in it. */
  unavailableNode?: ReactNode
  children?: ReactNode
}): JSX.Element {
  const blocked = unavailableNode ?? unavailableReason
  return (
    <div className={clsx('space-y-1', nested && 'border-l border-slate-500/20 pl-3')}>
      <div className="flex flex-wrap items-center gap-1">
        <Switch value={value} onChange={onChange} disabled={disabled || !!blocked} label={label} />
        <Tooltip title={description} label={`What "${label}" does`} />
        {busy ? <Spinner /> : null}
      </div>
      {/* Only the blocker stays on the page: it is the one line that says why
          the switch will not move, and hiding it behind the (i) would leave a
          dead toggle with no explanation. */}
      {blocked ? <div className="text-amber-600 dark:text-amber-400">{blocked}</div> : null}
      {children && value && !blocked ? <div className="pt-2">{children}</div> : null}
    </div>
  )
}

/** "FrameOS Cloud" settings section. Shared between the backend's global
 * settings page and the on-device frame admin — both servers implement the
 * same /api/cloud/* endpoints (see docs/cloud-link.md). */
export function CloudSettingsSection({
  headingId = 'settings-cloud',
  action,
}: {
  headingId?: string
  /** Rendered at the right of the "FrameOS Cloud" heading. The frame's own
   * admin panel puts its page actions (log out, the frame menu) there, since
   * this is the first heading it draws. */
  action?: ReactNode
}): JSX.Element | null {
  const {
    cloudStatus,
    cloudStatusLoading,
    cloudError,
    providerEditorOpen,
    isProviderUrlSubmitting,
    isCloudConnecting,
    isCloudDisconnecting,
    enabledFeatureDraft,
    featureChangesPending,
    isFeatureChangeSubmitting,
    cloudBackups,
    cloudBackupsLoading,
    isCloudBackupRunning,
    restoringBackupId,
    deletingBackupId,
    backupActionMessage,
    cloudBackupKey,
    cloudBackupKeyLoading,
    backupKeyVisible,
    hasBackupScope,
    anyBackupEnabled,
    pendingCloudSwitch,
  } = useValues(cloudLogic)
  const {
    connectCloud,
    disconnectCloud,
    setProviderEditorOpen,
    toggleEnabledFeature,
    applyFeatureChanges,
    cancelFeatureChange,
    resetFeatureDraft,
    linkCloudIdentity,
    unlinkCloudIdentity,
    setLocalFallback,
    setCloudManaged,
    setCloudLoginEnabled,
    setBackupFeature,
    loadCloudBackups,
    backupAllToCloud,
    restoreCloudBackup,
    deleteCloudBackup,
    showBackupKey,
    hideBackupKey,
    importBackupKey,
  } = useActions(cloudLogic)
  const frameAdminMode = isInFrameAdminMode()

  if (cloudStatus && !cloudStatus.enabled) {
    // FRAMEOS_CLOUD_URL=disabled hides the whole section
    return null
  }

  const status = cloudStatus?.status ?? 'disconnected'
  const providerUrl = cloudStatus?.provider_url ?? 'https://cloud.frameos.net'
  const providerHost = providerUrl.replace(/^https?:\/\//, '')
  const connection = cloudStatus?.connection
  const link = cloudStatus?.link
  // The server decides when the URL may change (only a live link blocks it).
  // Follow its answer instead of guessing, so the pencil is never offered for
  // an edit that would come back as a 409.
  const canEditProvider = cloudStatus?.can_edit_provider ?? true
  const expiresLabel = connection ? expiresInLabel(connection.expires_at) : null

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 pt-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <H6 id={headingId}>FrameOS Cloud</H6>
          {status === 'connected' ? <Tag color="teal">Connected</Tag> : null}
        </div>
        {action ? <div className="ml-auto flex shrink-0 items-center gap-2">{action}</div> : null}
      </div>
      <Box className="settings-account-card space-y-4">
        {cloudStatusLoading && !cloudStatus ? (
          <Spinner />
        ) : status === 'connected' && link ? (
          <>
            <div className="space-y-1 @md:flex @md:items-center @md:gap-2">
              <div className="@md:w-1/3 @md:shrink-0">
                <Label>Connected to</Label>
              </div>
              <div className="flex w-full flex-wrap items-center gap-2 text-sm">
                <span className="frameos-strong font-medium">{providerHost}</span>
                {link.account_email ? <span className="frameos-muted">as {link.account_email}</span> : null}
                <Button
                  size="small"
                  color="secondary"
                  onClick={() => {
                    void confirmDialog({
                      title: 'Disconnect from FrameOS Cloud?',
                      message: frameAdminMode
                        ? `This frame stops talking to ${providerHost}: it drops out of cloud management, your cloud scene library is no longer available here, and signing in with your cloud account stops working. ` +
                          'The admin password comes back, and the scenes already on the frame keep running.\n\nYou can connect again at any time.'
                        : `This backend stops talking to ${providerHost}: cloud backups pause, cloud-managed frames are no longer reachable from your account, and signing in through the cloud stops working. ` +
                          'Nothing on the frames themselves changes.\n\nYou can connect again at any time.',
                      confirmLabel: 'Disconnect',
                      danger: true,
                    }).then((confirmed) => {
                      if (confirmed) {
                        disconnectCloud()
                      }
                    })
                  }}
                  disabled={isCloudDisconnecting}
                  className="inline-flex items-center gap-2"
                >
                  {isCloudDisconnecting ? <Spinner /> : null}
                  Disconnect
                </Button>
              </div>
            </div>
            {link.usage ? (
              <div className="space-y-1 @md:flex @md:items-start @md:gap-2">
                <div className="@md:w-1/3 @md:shrink-0">
                  <Label>Cloud storage</Label>
                </div>
                <div className="w-full space-y-1 text-sm">
                  <div className="frameos-muted">
                    Private scenes {formatCloudBytes(link.usage.scenes.private_bytes)} of{' '}
                    {formatCloudBytes(link.usage.scenes.private_max_bytes)}
                    {link.usage.scenes.public_bytes > 0
                      ? ` · public scenes ${formatCloudBytes(link.usage.scenes.public_bytes)} (free)`
                      : ''}
                    {' · '}backups {formatCloudBytes(link.usage.backups.bytes)} of{' '}
                    {formatCloudBytes(link.usage.backups.max_bytes)}
                    {' · '}frame logs {formatCloudBytes(link.usage.frame_logs.bytes)} of{' '}
                    {formatCloudBytes(link.usage.frame_logs.max_bytes)}
                  </div>
                </div>
              </div>
            ) : null}
            {!frameAdminMode ? (
              <div className="space-y-1 @md:flex @md:items-start @md:gap-2">
                <div className="@md:w-1/3 @md:shrink-0">
                  <Label>Enabled features</Label>
                </div>
                <div className="w-full space-y-2 text-sm">
                  {cloudStatus?.upgrade ? (
                    <div className="space-y-2">
                      <div className="frameos-muted">Approve the feature change on the cloud with this code:</div>
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="frameos-strong select-all font-mono text-xl font-bold tracking-widest">
                          {cloudStatus.upgrade.user_code}
                        </span>
                        <Button
                          size="small"
                          color="primary"
                          onClick={() =>
                            window.open(
                              cloudStatus.upgrade?.verification_uri_complete ??
                                cloudStatus.upgrade?.verification_uri ??
                                undefined,
                              '_blank',
                              'noopener'
                            )
                          }
                        >
                          Open {providerHost}
                        </Button>
                      </div>
                      <div className="frameos-muted flex flex-wrap items-center gap-2">
                        <Spinner />
                        <span>Waiting for approval…</span>
                        <button
                          type="button"
                          onClick={cancelFeatureChange}
                          className="frameos-link font-semibold hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {availableCloudFeatures().map(({ scope, label, description, control, localKey }) => (
                        <label
                          key={scope}
                          className={clsx('flex items-start gap-2', control !== 'locked' && 'cursor-pointer')}
                        >
                          <input
                            type="checkbox"
                            checked={
                              control === 'locked'
                                ? true
                                : control === 'local'
                                ? Boolean(
                                    localKey === 'frames'
                                      ? cloudStatus?.backup_frames_enabled
                                      : localKey === 'scenes'
                                      ? cloudStatus?.backup_scenes_enabled
                                      : cloudStatus?.backup_frames_enabled || cloudStatus?.backup_scenes_enabled
                                  )
                                : enabledFeatureDraft.includes(scope)
                            }
                            disabled={control === 'locked'}
                            onChange={
                              control === 'toggle'
                                ? () => toggleEnabledFeature(scope)
                                : control === 'local' && localKey
                                ? (event) => setBackupFeature(localKey, event.target.checked)
                                : undefined
                            }
                            className="mt-0.5"
                          />
                          <span>
                            <span className="frameos-strong font-medium">{label}</span>{' '}
                            <span className="frameos-muted">— {description}</span>
                          </span>
                        </label>
                      ))}
                      {featureChangesPending ? (
                        <div className="flex flex-wrap items-center gap-2 pt-1">
                          <Button
                            size="small"
                            color="primary"
                            onClick={applyFeatureChanges}
                            disabled={isFeatureChangeSubmitting}
                            className="inline-flex items-center gap-2"
                          >
                            {isFeatureChangeSubmitting ? <Spinner color="white" /> : null}
                            Apply changes
                          </Button>
                          <Button size="small" color="secondary" onClick={resetFeatureDraft}>
                            Revert
                          </Button>
                          <span className="frameos-muted">Enabling a feature needs a quick approval on the cloud.</span>
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            ) : null}
            {!frameAdminMode && !inHassioIngress() && link.scopes.includes('auth:login') ? (
              <div className="space-y-1 @md:flex @md:items-center @md:gap-2">
                <div className="@md:w-1/3 @md:shrink-0">
                  <Label>Cloud login</Label>
                </div>
                <div className="flex w-full flex-wrap items-center gap-2 text-sm">
                  {cloudStatus?.identity ? (
                    <>
                      <span className="frameos-strong font-medium">
                        Your account is linked as{' '}
                        {cloudStatus.identity.email ?? cloudStatus.identity.name ?? 'cloud user'}
                      </span>
                      <Button size="small" color="secondary" onClick={unlinkCloudIdentity}>
                        Unlink
                      </Button>
                    </>
                  ) : (
                    <>
                      <span className="frameos-muted">Link your cloud account to log in here with FrameOS Cloud.</span>
                      <Button size="small" color="secondary" onClick={linkCloudIdentity}>
                        Link my cloud account
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ) : null}
            {frameAdminMode ? <FrameCloudStatusRow cloudStatus={cloudStatus} providerHost={providerHost} /> : null}
            {frameAdminMode ? (
              <div className="space-y-1 @md:flex @md:items-start @md:gap-2">
                <div className="@md:w-1/3 @md:shrink-0">
                  <Label>Cloud features</Label>
                </div>
                <div className="w-full space-y-4 text-sm">
                  <CloudFeatureSwitch
                    label="Manage this frame from FrameOS Cloud"
                    value={cloudStatus?.mode === 'managed'}
                    onChange={setCloudManaged}
                    busy={pendingCloudSwitch === 'managed'}
                    disabled={pendingCloudSwitch !== null || !cloudStatus?.managed_available}
                    description={
                      cloudStatus?.mode === 'managed'
                        ? `Scenes, settings and reboots can be driven from ${providerHost}, wherever you are. Turn this off and the frame keeps its place in your account but stops taking orders.`
                        : `Let ${providerHost} set this frame's scenes and settings from anywhere. Without it the frame is yours to drive from this page only.`
                    }
                    unavailableReason={
                      cloudStatus?.managed_available
                        ? undefined
                        : cloudStatus?.backend_managed
                        ? undefined
                        : 'This link was never approved for it. Disconnect and connect again to ask for the permission.'
                    }
                    unavailableNode={
                      !cloudStatus?.managed_available && cloudStatus?.backend_managed ? (
                        <>
                          A self-hosted FrameOS backend already manages this frame. Clear{' '}
                          <button
                            type="button"
                            className="frameos-link underline"
                            onClick={(e) => scrollToFrameSettingsSection(e, 'frame-settings-backend')}
                          >
                            Backend host
                          </button>{' '}
                          under &ldquo;Backend access&rdquo; first.
                        </>
                      ) : undefined
                    }
                  />
                  <CloudFeatureSwitch
                    label="Sign in here with FrameOS Cloud"
                    value={cloudStatus?.cloud_login_enabled !== false}
                    onChange={setCloudLoginEnabled}
                    busy={pendingCloudSwitch === 'login'}
                    disabled={pendingCloudSwitch !== null || !cloudStatus?.cloud_login_available}
                    description={`Put a "Sign in with FrameOS Cloud" button on this frame's login page, for the account that owns the link.`}
                    unavailableReason={
                      cloudStatus?.cloud_login_available
                        ? undefined
                        : 'This link was never approved for it. Disconnect and connect again to ask for the permission.'
                    }
                  >
                    <CloudFeatureSwitch
                      nested
                      label="Keep the admin password working"
                      value={cloudStatus?.local_fallback_enabled !== false}
                      onChange={setLocalFallback}
                      disabled={pendingCloudSwitch !== null}
                      description="Off means the cloud button is the only way in. The password comes back by itself if the link ever goes away, so this cannot lock you out."
                    />
                  </CloudFeatureSwitch>
                </div>
              </div>
            ) : null}
            {!frameAdminMode && !inHassioIngress() && cloudStatus?.identity && link.scopes.includes('auth:login') ? (
              <div className="space-y-1 @md:flex @md:items-center @md:gap-2">
                <div className="@md:w-1/3 @md:shrink-0">
                  <Label>Local password login</Label>
                </div>
                <div className="flex w-full flex-wrap items-center gap-2 text-sm">
                  {cloudStatus?.local_fallback_enabled === false ? (
                    <>
                      <Tag color="orange">Disabled</Tag>
                      <Button size="small" color="secondary" onClick={() => setLocalFallback(true)}>
                        Enable local passwords
                      </Button>
                    </>
                  ) : (
                    <>
                      <Tag color="teal">Enabled</Tag>
                      <Button size="small" color="secondary" onClick={() => setLocalFallback(false)}>
                        Disable local passwords
                      </Button>
                      <span className="frameos-muted">
                        Requires a verified cloud login by the account that owns this install.
                      </span>
                    </>
                  )}
                </div>
              </div>
            ) : null}
            {!frameAdminMode && hasBackupScope ? (
              <div className="space-y-1 @md:flex @md:items-start @md:gap-2">
                <div className="@md:w-1/3 @md:shrink-0">
                  <Label>Cloud backups</Label>
                </div>
                <div className="w-full space-y-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="small"
                      color="secondary"
                      onClick={backupAllToCloud}
                      disabled={isCloudBackupRunning || !anyBackupEnabled}
                      className="inline-flex items-center gap-2"
                    >
                      {isCloudBackupRunning ? <Spinner /> : null}
                      Back up now
                    </Button>
                    <Button size="small" color="secondary" onClick={loadCloudBackups} disabled={cloudBackupsLoading}>
                      {cloudBackups === null ? 'Show backups' : 'Refresh'}
                    </Button>
                    <span className="frameos-muted">
                      {!anyBackupEnabled
                        ? 'Backups are switched off — enable cloud backups above.'
                        : 'Frames back up automatically after every deploy; payloads are encrypted with your backup key.'}
                    </span>
                  </div>
                  {cloudBackupsLoading ? <Spinner /> : null}
                  {cloudBackups !== null && cloudBackups.length === 0 && !cloudBackupsLoading ? (
                    <div className="frameos-muted">No backups stored yet.</div>
                  ) : null}
                  {cloudBackups && cloudBackups.length > 0 ? (
                    <div className="space-y-1">
                      {cloudBackups.map((backup) => (
                        <div key={backup.id} className="flex flex-wrap items-center gap-2">
                          <Tag color={backup.kind === 'frames' ? 'blue' : 'gray'}>
                            {backup.kind === 'frames' ? 'frame' : 'scene'}
                          </Tag>
                          <span className="frameos-strong font-medium">{backup.name ?? backup.item_key}</span>
                          <span className="frameos-muted">
                            {Number.isFinite(backup.size_bytes)
                              ? `${Math.max(1, Math.round(backup.size_bytes / 1024))} KB, `
                              : ''}
                            {new Date(backup.updated_at).toLocaleString()}
                          </span>
                          <Button
                            size="small"
                            color="secondary"
                            onClick={() => {
                              const kind = backup.kind === 'frames' ? 'frame' : 'scene'
                              void confirmDialog({
                                title: `Restore this ${kind}?`,
                                message: `Restore "${
                                  backup.name ?? backup.item_key
                                }" as a new ${kind} in this project?`,
                                confirmLabel: 'Restore',
                              }).then((confirmed) => {
                                if (confirmed) {
                                  restoreCloudBackup(backup.id)
                                }
                              })
                            }}
                            disabled={restoringBackupId === backup.id}
                            className="inline-flex items-center gap-2"
                          >
                            {restoringBackupId === backup.id ? <Spinner /> : null}
                            Restore
                          </Button>
                          <Button
                            size="small"
                            color="secondary"
                            onClick={() => {
                              void confirmDialog({
                                title: 'Delete this backup?',
                                message: `Delete the cloud backup "${
                                  backup.name ?? backup.item_key
                                }"?\n\nThis cannot be undone.`,
                                confirmLabel: 'Delete backup',
                                danger: true,
                              }).then((confirmed) => {
                                if (confirmed) {
                                  deleteCloudBackup(backup.id)
                                }
                              })
                            }}
                            disabled={deletingBackupId === backup.id}
                            className="inline-flex items-center gap-2"
                          >
                            {deletingBackupId === backup.id ? <Spinner /> : null}
                            Delete
                          </Button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {backupActionMessage ? (
                    <div className="text-green-600 dark:text-green-400">{backupActionMessage}</div>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="frameos-muted">
                      Backup key{cloudStatus?.backup_key_fingerprint ? ` ${cloudStatus.backup_key_fingerprint}` : ''}:
                    </span>
                    {backupKeyVisible && cloudBackupKey ? (
                      <>
                        <code className="frameos-strong select-all break-all font-mono">
                          {cloudBackupKey.recovery_code}
                        </code>
                        <Button size="small" color="secondary" onClick={hideBackupKey}>
                          Hide
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="small"
                        color="secondary"
                        onClick={showBackupKey}
                        disabled={cloudBackupKeyLoading}
                        className="inline-flex items-center gap-2"
                      >
                        {cloudBackupKeyLoading ? <Spinner /> : null}
                        Show recovery key
                      </Button>
                    )}
                  </div>
                  <div className="frameos-muted">
                    Save the recovery key in your password manager. Backups are encrypted with it before upload — after
                    reinstalling this backend, paste it below to restore them.
                  </div>
                  <form
                    className="flex flex-wrap items-center gap-2"
                    onSubmit={(event) => {
                      event.preventDefault()
                      const input = event.currentTarget.elements.namedItem('recoveryCode') as HTMLInputElement | null
                      if (input?.value.trim()) {
                        importBackupKey(input.value.trim())
                        input.value = ''
                      }
                    }}
                  >
                    <div className="w-72">
                      <TextInput name="recoveryCode" placeholder="FRBK1-…" className="font-mono" />
                    </div>
                    <Button size="small" color="secondary" type="submit">
                      Import recovery key
                    </Button>
                  </form>
                  <div>
                    <a className="frameos-link font-medium hover:underline" href="/api/backup/export">
                      Download a local backup (.tar.gz)
                    </a>{' '}
                    <span className="frameos-muted">
                      — projects, frames, and scenes with credentials included; never leaves this machine.
                    </span>
                  </div>
                </div>
              </div>
            ) : null}
          </>
        ) : status === 'connecting' && connection ? (
          <>
            <div className="frameos-muted text-sm">
              To link this FrameOS with your cloud account, open the approval page and enter this code:
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <span className="frameos-strong select-all font-mono text-2xl font-bold tracking-widest">
                {connection.user_code}
              </span>
              {connection.verification_uri_complete || connection.verification_uri ? (
                <Button
                  size="small"
                  color="primary"
                  onClick={() =>
                    window.open(
                      connection.verification_uri_complete ?? connection.verification_uri ?? undefined,
                      '_blank',
                      'noopener'
                    )
                  }
                >
                  Open {providerHost}
                </Button>
              ) : null}
            </div>
            <div className="frameos-muted flex flex-wrap items-center gap-2 text-sm">
              <Spinner />
              <span>Waiting for approval{expiresLabel ? ` (${expiresLabel})` : ''}…</span>
              <button
                type="button"
                onClick={disconnectCloud}
                className="frameos-link font-semibold hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
              >
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="space-y-1 @md:flex @md:items-center @md:gap-2">
              <div className="@md:w-1/3 @md:shrink-0">
                <Label>Cloud server</Label>
              </div>
              {providerEditorOpen && canEditProvider ? (
                <Form
                  logic={cloudLogic}
                  formKey="providerUrl"
                  enableFormOnSubmit
                  className="flex w-full min-w-0 flex-wrap items-start gap-2"
                >
                  <Field name="provider_url" className="min-w-[14rem] flex-1">
                    <TextInput
                      placeholder={cloudStatus?.default_provider_url ?? 'https://cloud.frameos.net'}
                      autoFocus
                    />
                  </Field>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <Button
                      color="secondary"
                      size="small"
                      onClick={() => setProviderEditorOpen(false)}
                      disabled={isProviderUrlSubmitting}
                    >
                      Cancel
                    </Button>
                    <Button type="submit" color="primary" size="small" disabled={isProviderUrlSubmitting}>
                      {isProviderUrlSubmitting ? <Spinner color="white" /> : null}
                      Save
                    </Button>
                  </div>
                </Form>
              ) : (
                <div className="flex w-full flex-wrap items-center gap-2 text-sm">
                  <span className="frameos-strong font-medium">{providerUrl}</span>
                  <button
                    type="button"
                    onClick={() => setProviderEditorOpen(true)}
                    disabled={!canEditProvider}
                    title={
                      canEditProvider
                        ? 'Edit cloud server URL'
                        : 'Disconnect from FrameOS Cloud before changing the server URL'
                    }
                    aria-label="Edit cloud server URL"
                    className="frameos-muted inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border-0 bg-transparent !px-0 !py-0 transition hover:bg-slate-500/10 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                  >
                    <PencilSquareIcon className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>
            <div className="@md:flex @md:items-center @md:gap-2">
              <div className="hidden @md:block @md:w-1/3 @md:shrink-0" />
              <div className="flex w-full flex-wrap items-center gap-2">
                <Button
                  size="small"
                  color="primary"
                  onClick={connectCloud}
                  disabled={isCloudConnecting || providerEditorOpen}
                  className="inline-flex items-center gap-2"
                >
                  {isCloudConnecting ? <Spinner color="white" /> : null}
                  Connect to {providerHost}
                </Button>
              </div>
            </div>
            {cloudStatus?.poll_error ? (
              <div className="text-sm text-red-500">{pollErrorMessage(cloudStatus.poll_error)}</div>
            ) : null}
            <div className="frameos-muted text-sm">
              {frameAdminMode
                ? 'Approving the link hands this frame to your cloud account: it can then be driven from the cloud, and you can sign in here with your cloud account instead of the admin password. Both become switches on this page, so you can turn either one off again without disconnecting.'
                : 'Connect this backend to a cloud account to optionally enable a few extra features: cloud login, offsite backups of your frames and scenes, etc. Soon also remote access and more.'}
            </div>
          </>
        )}
        {cloudError ? <div className="text-sm text-red-500">{cloudError}</div> : null}
      </Box>
    </div>
  )
}
