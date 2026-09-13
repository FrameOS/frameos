import { useEffect, useState } from 'react'
import { useActions, useValues } from 'kea'
import equal from 'fast-deep-equal'
import { ArrowDownTrayIcon, ArrowPathIcon, InformationCircleIcon } from '@heroicons/react/24/outline'
import { Button } from '../../../../../components/Button'
import { Field } from '../../../../../components/Field'
import { H6 } from '../../../../../components/H6'
import { Label } from '../../../../../components/Label'
import { SecretField } from '../../../../../components/SecretField'
import { Spinner } from '../../../../../components/Spinner'
import { Switch } from '../../../../../components/Switch'
import { Tag } from '../../../../../components/Tag'
import { TextInput } from '../../../../../components/TextInput'
import { Tooltip } from '../../../../../components/Tooltip'
import { appsModel } from '../../../../../models/appsModel'
import { framesModel } from '../../../../../models/framesModel'
import { settingsLogic } from '../../../../settings/settingsLogic'
import {
  listCloudFrameScenes,
  setCloudFrameScenes,
  setCloudFrameServiceSettingsEnabled,
  setCloudFrameTelemetryEnabled,
} from '../../../../../utils/cloudFrameApi'
import type { CloudFrameSceneRow } from '../../../../../utils/cloudFrameScenes'
import { collectSecretSettingsFromScenes, getSettingsValue, settingsDetails } from '../../secretSettings'
import { frameLogic } from '../../../frameLogic'
import { frameAdminUpgradeLogic } from '../frameAdminUpgradeLogic'
import {
  displayVersion,
  hasSettingsFieldValue,
  latestUpgradeVersion,
  settingsInputValue,
  upgradeBuildLabel,
  upgradeHostLabel,
  upgradeStatusColor,
  upgradeStatusLabel,
} from '../frameSettingsHelpers'

/**
 * Sections about the ACCOUNT's credentials and the frame's relationship to a
 * server, rather than about the device's own configuration: which service
 * keys reach this frame, whether it ships telemetry, and (on the frame's own
 * admin panel) the keys it holds and the FrameOS version it runs.
 *
 * They mount their own logics: none of them reads the frame form, so none of
 * them needs the Settings context.
 */

const FRAME_ADMIN_SERVICE_SETTING_KEYS = ['frameOS', 'openAI', 'homeAssistant', 'github', 'immich', 'unsplash'] as const

export function FrameAdminServiceSecretsSection(): JSX.Element {
  const { settings, savedSettings, settingsChanged, isSettingsSubmitting } = useValues(settingsLogic)
  const { setSettingsValue, submitSettings } = useActions(settingsLogic)

  return (
    <>
      <H6 id="frame-settings-service-secrets" className="mt-2">
        Service secrets
      </H6>
      <div className="pl-2 @md:pl-8 space-y-3">
        <div className="frameos-muted text-sm">Credentials stored on this frame and used by scene apps.</div>
        <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-2">
          {FRAME_ADMIN_SERVICE_SETTING_KEYS.map((settingsKey) => {
            const details = settingsDetails[settingsKey]
            const saved = details.fields.every((field) =>
              hasSettingsFieldValue(getSettingsValue(savedSettings, field.path))
            )

            return (
              // Collapsed by default: a dozen services' worth of key fields
              // pushed every other setting off the page, and the summary row
              // already says which ones are filled in. Native <details>, so no
              // state to keep and the browser handles the toggle.
              <details key={settingsKey} className="frameos-inset rounded-lg border px-3 py-3 text-sm">
                <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2">
                  <div className="frameos-strong font-semibold">
                    {details.title}
                    {details.description ? <Tooltip title={details.description} /> : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <Tag color={saved ? 'teal' : 'yellow'}>{saved ? 'Saved' : 'Missing'}</Tag>
                    {details.fields.some((field) => field.secret) ? <Tag color="orange">Secret</Tag> : null}
                  </div>
                </summary>
                <div className="mt-3 space-y-2">
                  {details.fields.map((field) => {
                    const value = settingsInputValue(getSettingsValue(settings, field.path))
                    return (
                      <div key={field.path.join('.')} className="space-y-1 @md:flex @md:gap-2">
                        <Label className="@md:w-1/3">{field.label}</Label>
                        <div className="w-full">
                          {field.secret ? (
                            <SecretField value={value}>
                              <TextInput
                                value={value}
                                onChange={(nextValue) => setSettingsValue(field.path as any, nextValue)}
                              />
                            </SecretField>
                          ) : (
                            <TextInput
                              value={value}
                              onChange={(nextValue) => setSettingsValue(field.path as any, nextValue)}
                            />
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </details>
            )
          })}
        </div>
        <div className="flex justify-end">
          <Button
            size="small"
            color={settingsChanged ? 'primary' : 'secondary'}
            disabled={!settingsChanged || isSettingsSubmitting}
            onClick={submitSettings}
            className="inline-flex items-center gap-2"
          >
            {isSettingsSubmitting ? <Spinner color="white" /> : null}
            Save service secrets
          </Button>
        </div>
      </div>
    </>
  )
}

/**
 * Cloud-managed frames only: which service-settings groups this frame's
 * scenes ask for, and whether the account's keys for them actually reach the
 * device. Two independent facts, and a scene that renders "please provide an
 * API key" can be either one — hence both on screen:
 *
 *  - the DECLARED groups come from the frame row (the cloud denormalizes them
 *    on every scene assignment) and say what the scenes want;
 *  - the SWITCH is the owner's per-frame grant of `settings:services`. Off
 *    means the device's pull 403s and it drops every cloud-owned key.
 *
 * The keys themselves are account-level (Settings → service secrets) and never
 * travel through this panel.
 */
/**
 * Self-hosted frames: the service keys a scene from the public scene store
 * may read on this frame. A scene the owner authored gets what its apps
 * declare, as it always has; a store scene is anyone's code, so its
 * declaration is a request the owner grants here, per group — the backend's
 * get_frame_json ships a group a store scene declares only when it is in
 * frame.service_setting_groups (the same field and meaning as the cloud's
 * per-frame grant). Saved with the frame form; a deploy follows because it is
 * a frame.json change.
 */
export function StoreSceneServiceSettingsSection(): JSX.Element | null {
  const { frameForm } = useValues(frameLogic)
  const { setFrameFormValues } = useActions(frameLogic)
  const { apps } = useValues(appsModel)
  const storeScenes = (frameForm.scenes ?? []).filter(
    (scene) => typeof (scene as { origin?: { storeSceneId?: unknown } }).origin?.storeSceneId === 'string'
  )
  if (storeScenes.length === 0) {
    return null
  }
  const granted = frameForm.service_setting_groups ?? []
  const setGranted = (next: string[]): void => setFrameFormValues({ service_setting_groups: next })
  return (
    <>
      {/* First child of the frame form on the on-device panel, where the
          form's own vertical rhythm gives it nothing above: carry the gap. */}
      <H6 id="frame-settings-store-scene-services" className="mt-4">
        Secrets shared with scenes
      </H6>
      <div className="pl-2 @md:pl-8 space-y-2">
        <div className="frameos-muted text-xs">
          Store scenes are someone else&apos;s code. Untick a key to take it away. Applied on the next deploy.
        </div>
        {storeScenes.map((scene) => {
          const declared = collectSecretSettingsFromScenes([scene], apps)
          return (
            <div key={scene.id} className="space-y-1">
              <div className="text-sm">{scene.name || scene.id}</div>
              {declared.length === 0 ? (
                <div className="frameos-muted text-xs pl-3">Needs no service keys.</div>
              ) : (
                <div className="flex flex-wrap gap-3 pl-3">
                  {declared.map((group) => (
                    <label key={group} className="inline-flex items-center gap-1 text-xs cursor-pointer">
                      <input
                        type="checkbox"
                        checked={granted.includes(group)}
                        onChange={(e) =>
                          setGranted(
                            e.target.checked
                              ? [...granted.filter((g) => g !== group), group]
                              : granted.filter((g) => g !== group)
                          )
                        }
                      />
                      {settingsDetails[group]?.title ?? group}
                    </label>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}

export function CloudServiceSettingsSection(): JSX.Element {
  const { frameId, frame } = useValues(frameLogic)
  const { loadFrame, hydrateCloudFrameScenes } = useActions(framesModel)
  const { savedSettings } = useValues(settingsLogic)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const groups = frame?.service_setting_groups ?? []
  const enabled = frame?.service_settings_enabled === true

  // Per-scene grants: the server's assignment list, each scene's declared
  // groups as checkboxes. Loaded on demand (the frame row carries only the
  // granted union), saved by re-posting the whole list with settings_groups.
  const [rows, setRows] = useState<CloudFrameSceneRow[] | null>(null)
  const [rowsError, setRowsError] = useState<string | null>(null)
  const [draftGrants, setDraftGrants] = useState<Record<string, string[]>>({})
  const [savingGrants, setSavingGrants] = useState(false)
  const loadRows = async (): Promise<void> => {
    try {
      const listed = await listCloudFrameScenes(frameId)
      setRows(listed)
      setDraftGrants(Object.fromEntries(listed.map((row) => [row.scene_id, row.granted_settings_groups ?? []])))
      setRowsError(null)
    } catch (e) {
      setRowsError(e instanceof Error ? e.message : String(e))
    }
  }
  useEffect(() => {
    void loadRows()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameId, frame?.assigned_checksum])
  const grantsChanged =
    rows !== null &&
    rows.some(
      (row) => !equal([...(row.granted_settings_groups ?? [])].sort(), [...(draftGrants[row.scene_id] ?? [])].sort())
    )
  const saveGrants = async (): Promise<void> => {
    if (!rows) {
      return
    }
    setSavingGrants(true)
    setError(null)
    try {
      await setCloudFrameScenes(
        frameId,
        rows.map((row) => ({
          scene_id: row.scene_id,
          scene_version: row.scene_version ?? null,
          settings_groups: draftGrants[row.scene_id] ?? [],
        })),
        frame?.active_scene_id
      )
      await loadRows()
      loadFrame(frameId)
      hydrateCloudFrameScenes(frameId, true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingGrants(false)
    }
  }

  const toggle = async (next: boolean): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      await setCloudFrameServiceSettingsEnabled(frameId, next)
      loadFrame(frameId)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <H6 id="frame-settings-service-settings" className="mt-2">
        Service settings
      </H6>
      <div className="pl-2 @md:pl-8 space-y-3">
        <div className="frameos-muted text-sm">
          API keys your account stores (Settings → service secrets) are fetched by the frame itself over its own
          authenticated connection. They are never pushed through the command queue.
        </div>
        <Field name="_noop" label="Deliver keys to this frame">
          <div className="w-full space-y-1">
            <Switch value={enabled} onChange={toggle} disabled={saving} label={enabled ? 'Enabled' : 'Disabled'} />
            {!enabled ? (
              <div className="frameos-muted text-xs">
                The frame is refused the keys and drops any it still holds at its next check.
              </div>
            ) : null}
            {error ? <div className="text-red-300 text-xs">{error}</div> : null}
          </div>
        </Field>
        <Field name="_noop" label="Delivered to this frame">
          <div className="w-full">
            {groups.length === 0 ? (
              <div className="frameos-muted text-sm">None — no scene on this frame has been granted a service key.</div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {groups.map((group) => {
                  const details = settingsDetails[group]
                  const saved = details
                    ? details.fields.every((field) =>
                        hasSettingsFieldValue(getSettingsValue(savedSettings, field.path))
                      )
                    : false
                  return (
                    <Tag key={group} color={saved ? 'teal' : 'yellow'}>
                      {details?.title ?? group}
                      {saved ? '' : ' — not set'}
                    </Tag>
                  )
                })}
              </div>
            )}
          </div>
        </Field>
        <Field name="_noop" label="Granted per scene">
          <div className="w-full space-y-2">
            <div className="frameos-muted text-xs">
              A scene only asks for a key; you decide which scenes get which. Untick a service to keep that key away
              from a scene, even if the scene declares it.
            </div>
            {rowsError ? <div className="text-red-300 text-xs">{rowsError}</div> : null}
            {rows === null && !rowsError ? <Spinner /> : null}
            {rows && rows.length === 0 ? (
              <div className="frameos-muted text-sm">No scenes are assigned to this frame.</div>
            ) : null}
            {rows?.map((row) => {
              const declared = row.declared_settings_groups ?? []
              const granted = draftGrants[row.scene_id] ?? []
              return (
                <div key={row.scene_id} className="space-y-1">
                  <div className="text-sm">{row.name || row.slug || row.scene_id}</div>
                  {declared.length === 0 ? (
                    <div className="frameos-muted text-xs pl-3">Needs no service keys.</div>
                  ) : (
                    <div className="flex flex-wrap gap-3 pl-3">
                      {declared.map((group) => (
                        <label key={group} className="inline-flex items-center gap-1 text-xs cursor-pointer">
                          <input
                            type="checkbox"
                            checked={granted.includes(group)}
                            disabled={savingGrants}
                            onChange={(e) =>
                              setDraftGrants((current) => ({
                                ...current,
                                [row.scene_id]: e.target.checked
                                  ? [...granted.filter((g) => g !== group), group]
                                  : granted.filter((g) => g !== group),
                              }))
                            }
                          />
                          {settingsDetails[group]?.title ?? group}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
            {rows && rows.length > 0 ? (
              <div className="flex justify-end">
                <Button
                  size="small"
                  color={grantsChanged ? 'primary' : 'secondary'}
                  disabled={!grantsChanged || savingGrants}
                  onClick={() => void saveGrants()}
                  className="inline-flex items-center gap-2"
                >
                  {savingGrants ? <Spinner color="white" /> : null}
                  Save grants
                </Button>
              </div>
            ) : null}
          </div>
        </Field>
      </div>
    </>
  )
}

/**
 * Cloud-managed frames only: whether the device ships its logs and metrics to
 * the cloud at all. The owner's per-frame grant of `telemetry:logs` +
 * `telemetry:metrics`; frames enrolled before 2026-08-03 never received it
 * and sit with an empty Logs panel that nothing explains — this is the
 * switch that explains it. Scopes are pinned per connection, so the cloud
 * restarts the runtime on every change; the panel says so.
 */
export function CloudTelemetrySection(): JSX.Element | null {
  const { frameId, frame } = useValues(frameLogic)
  const { loadFrame } = useActions(framesModel)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Absent = the row we hold came from a broadcast without the link; do not
  // draw a switch in an unknown position.
  if (typeof frame?.telemetry_enabled !== 'boolean') {
    return null
  }
  const enabled = frame.telemetry_enabled

  const toggle = async (next: boolean): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      await setCloudFrameTelemetryEnabled(frameId, next)
      loadFrame(frameId)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <H6 id="frame-settings-telemetry" className="mt-2">
        Logs and metrics
      </H6>
      <div className="pl-2 @md:pl-8 space-y-3">
        <Field name="_noop" label="Ship logs and metrics to the cloud">
          <div className="w-full space-y-1">
            <Switch value={enabled} onChange={toggle} disabled={saving} label={enabled ? 'Enabled' : 'Disabled'} />
            <div className="frameos-muted text-xs">
              {enabled
                ? 'The Logs and Metrics panels fill from the device. Changing this restarts FrameOS on the frame.'
                : 'The Logs and Metrics panels stay empty. Frames set up before August 2026 start out here; enabling restarts FrameOS on the frame.'}
            </div>
            {error ? <div className="text-red-300 text-xs">{error}</div> : null}
          </div>
        </Field>
      </div>
    </>
  )
}

export function FrameAdminUpgradeSection(): JSX.Element {
  const { upgradeStatus, upgradeStatusLoading, isUpgradePolling, upgradeError, upgradeStatusIsActive } =
    useValues(frameAdminUpgradeLogic)
  const { checkUpgradeStatus, dryRunUpgrade, confirmStartUpgrade, loadUpgradeStatus } =
    useActions(frameAdminUpgradeLogic)

  const latestVersion = latestUpgradeVersion(upgradeStatus)
  const updateAvailable = upgradeStatus?.update_available === true
  const checkingOrPolling = upgradeStatusLoading || isUpgradePolling || upgradeStatusIsActive
  const upgradeDisabled = checkingOrPolling || !updateAvailable
  const releaseUrl = upgradeStatus?.latest_release?.html_url
  const build = upgradeBuildLabel(upgradeStatus)
  const hostLabel = upgradeHostLabel(upgradeStatus)

  return (
    <>
      <H6 id="frame-settings-upgrade" className="mt-2">
        FrameOS upgrade
      </H6>
      <div className="pl-2 @md:pl-8 space-y-3">
        <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
          <div className="frameos-inset rounded-lg border px-3 py-3 text-sm space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div className="frameos-muted">Running version</div>
              <div className="frameos-strong font-semibold">{displayVersion(upgradeStatus?.current_version)}</div>
            </div>
            {hostLabel ? (
              <div className="flex items-center justify-between gap-3">
                <div className="frameos-muted">Operating system</div>
                <div className="frameos-strong text-right">{hostLabel}</div>
              </div>
            ) : null}
            <div className="flex items-center justify-between gap-3">
              <div className="frameos-muted">Release build</div>
              <div className="frameos-strong font-mono text-xs inline-flex items-center gap-1">
                {build.label}
                {build.hint ? (
                  <Tooltip title={build.hint} label="About this release build">
                    <InformationCircleIcon className="w-4 h-4" aria-hidden="true" />
                  </Tooltip>
                ) : null}
              </div>
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="frameos-muted">Latest release</div>
              {releaseUrl && latestVersion ? (
                <a
                  href={releaseUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="frameos-link font-semibold hover:underline"
                >
                  {latestVersion}
                </a>
              ) : (
                <div className="frameos-strong font-semibold">{displayVersion(latestVersion)}</div>
              )}
            </div>
          </div>
          <div className="frameos-inset rounded-lg border px-3 py-3 text-sm space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div className="frameos-muted">Status</div>
              <Tag color={upgradeStatusColor(upgradeStatus?.status)}>{upgradeStatusLabel(upgradeStatus?.status)}</Tag>
            </div>
            <div className="frameos-muted min-h-[2.5rem]">
              {upgradeError ||
                upgradeStatus?.target_error ||
                upgradeStatus?.latest_error ||
                upgradeStatus?.message ||
                (updateAvailable ? 'A newer stable release is available.' : 'No upgrade has been checked yet.')}
            </div>
            {upgradeStatus?.log_path ? (
              <div className="frameos-muted text-xs break-all">Log: {upgradeStatus.log_path}</div>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            size="small"
            color="secondary"
            disabled={checkingOrPolling}
            onClick={() => loadUpgradeStatus()}
            className="inline-flex items-center gap-2"
          >
            {upgradeStatusLoading ? <Spinner /> : <ArrowPathIcon className="h-4 w-4" />}
            Refresh
          </Button>
          <Button
            size="small"
            color="secondary"
            disabled={checkingOrPolling}
            onClick={() => checkUpgradeStatus()}
            className="inline-flex items-center gap-2"
          >
            {upgradeStatusLoading ? <Spinner /> : <ArrowPathIcon className="h-4 w-4" />}
            Check latest
          </Button>
          <Button
            size="small"
            color="secondary"
            disabled={checkingOrPolling}
            onClick={() => dryRunUpgrade()}
            className="inline-flex items-center gap-2"
          >
            {upgradeStatusLoading ? <Spinner /> : <ArrowPathIcon className="h-4 w-4" />}
            Dry run
          </Button>
          <Button
            size="small"
            color={updateAvailable ? 'primary' : 'secondary'}
            disabled={upgradeDisabled}
            onClick={() => confirmStartUpgrade()}
            className="inline-flex items-center gap-2"
          >
            {checkingOrPolling ? <Spinner color="white" /> : <ArrowDownTrayIcon className="h-4 w-4" />}
            Upgrade
          </Button>
        </div>
      </div>
    </>
  )
}
