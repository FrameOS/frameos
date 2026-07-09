import { useActions, useValues } from 'kea'
import { Form } from 'kea-forms'
import { PencilSquareIcon } from '@heroicons/react/24/solid'

import { Box } from '../../components/Box'
import { Button } from '../../components/Button'
import { Field } from '../../components/Field'
import { H6 } from '../../components/H6'
import { Label } from '../../components/Label'
import { Spinner } from '../../components/Spinner'
import { Tag } from '../../components/Tag'
import { TextInput } from '../../components/TextInput'
import { isInFrameAdminMode } from '../../utils/frameAdmin'
import { CLOUD_FEATURES, cloudLogic } from './cloudLogic'

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

/** "FrameOS Cloud" settings section. Shared between the backend's global
 * settings page and the on-device frame admin — both servers implement the
 * same /api/cloud/* endpoints (see docs/cloud-link.md). */
export function CloudSettingsSection({ headingId = 'settings-cloud' }: { headingId?: string }): JSX.Element | null {
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
    hasBackupScope,
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
    loadCloudBackups,
    backupAllToCloud,
    restoreCloudBackup,
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
  const expiresLabel = connection ? expiresInLabel(connection.expires_at) : null

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 pt-4">
        <H6 id={headingId}>FrameOS Cloud</H6>
        {status === 'connected' ? <Tag color="teal">Connected</Tag> : null}
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
                  onClick={disconnectCloud}
                  disabled={isCloudDisconnecting}
                  className="inline-flex items-center gap-2"
                >
                  {isCloudDisconnecting ? <Spinner /> : null}
                  Disconnect
                </Button>
              </div>
            </div>
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
                      {CLOUD_FEATURES.map(({ scope, label, description }) => (
                        <label key={scope} className="flex cursor-pointer items-start gap-2">
                          <input
                            type="checkbox"
                            checked={enabledFeatureDraft.includes(scope)}
                            onChange={() => toggleEnabledFeature(scope)}
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
            {!frameAdminMode && link.scopes.includes('auth:login') ? (
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
            {!frameAdminMode && cloudStatus?.identity && link.scopes.includes('auth:login') ? (
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
                      disabled={isCloudBackupRunning}
                      className="inline-flex items-center gap-2"
                    >
                      {isCloudBackupRunning ? <Spinner /> : null}
                      Back up now
                    </Button>
                    <Button size="small" color="secondary" onClick={loadCloudBackups} disabled={cloudBackupsLoading}>
                      {cloudBackups === null ? 'Show backups' : 'Refresh'}
                    </Button>
                    <span className="frameos-muted">Frames are also backed up automatically after every deploy.</span>
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
                            {backup.kind === 'frames' ? 'frame' : 'template'}
                          </Tag>
                          <span className="frameos-strong font-medium">{backup.name ?? backup.item_key}</span>
                          <span className="frameos-muted">
                            {Math.max(1, Math.round(backup.size_bytes / 1024))} KB,{' '}
                            {new Date(backup.updated_at).toLocaleString()}
                          </span>
                          <Button
                            size="small"
                            color="secondary"
                            onClick={() => restoreCloudBackup(backup.id)}
                            disabled={restoringBackupId === backup.id}
                            className="inline-flex items-center gap-2"
                          >
                            {restoringBackupId === backup.id ? <Spinner /> : null}
                            Restore
                          </Button>
                        </div>
                      ))}
                    </div>
                  ) : null}
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
              {providerEditorOpen ? (
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
                    title="Edit cloud server URL"
                    aria-label="Edit cloud server URL"
                    className="frameos-muted inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border-0 bg-transparent !px-0 !py-0 transition hover:bg-slate-500/10 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
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
              Connect this backend to a cloud account to optionally enable a few extra features: cloud login, offsite
              backups of your frames and templates, etc. Soon also remote access and more.
            </div>
          </>
        )}
        {cloudError ? <div className="text-sm text-red-500">{cloudError}</div> : null}
      </Box>
    </div>
  )
}
