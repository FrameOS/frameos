import { Form } from 'kea-forms'
import { useActions, useValues } from 'kea'
import { ArrowDownTrayIcon, ArrowLeftIcon, CommandLineIcon, ServerStackIcon } from '@heroicons/react/24/outline'
import { BUILDROOT_RASPBERRY_PI_ZERO_2_W, devices, buildrootPlatforms, rpiOSPlatforms } from '../../devices'
import { newFrameForm } from './newFrameForm'
import { FrameInstallMethod, NewFrameFormType } from '../../types'
import { settingsLogic } from '../settings/settingsLogic'
import { normalizedTimezone } from '../../utils/timezone'
import { timezoneOptions } from '../../decorators/timezones'

function isLocalServer(host?: string | null): boolean {
  const localHostRegex = /^(localhost|0\.0\.0\.0|127\.0\.0\.1|\[::1\])(:\d+)?$/
  return !!host && localHostRegex.test(host)
}

function errorText(error: unknown): string | null {
  if (!error) {
    return null
  }
  return String(error)
}

function ModeButton({
  children,
  onClick,
  title,
  description,
}: {
  children: JSX.Element | string
  onClick: () => void
  title: string
  description: string
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="frameos-segment flex flex-1 flex-col items-start justify-start rounded-xl border border-slate-200 bg-white/70 px-3 py-2 text-left text-slate-600 transition hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
    >
      <span className="flex items-center gap-2 text-sm font-semibold">
        {children}
        {title}
      </span>
      <span className="mt-1 text-xs leading-4 text-slate-500">{description}</span>
    </button>
  )
}

function FormField({
  label,
  error,
  children,
  hint,
}: {
  label: JSX.Element | string
  error?: unknown
  children: JSX.Element
  hint?: JSX.Element | string | null
}): JSX.Element {
  const resolvedError = errorText(error)
  return (
    <label className="block space-y-2">
      <span className="frameos-form-label block text-sm font-semibold text-slate-700">{label}</span>
      {children}
      {hint ? <span className="frameos-form-hint block text-xs leading-relaxed text-slate-500">{hint}</span> : null}
      {resolvedError ? <span className="block text-xs font-semibold text-red-500">{resolvedError}</span> : null}
    </label>
  )
}

function textInputClassName(): string {
  return 'frameos-form-control h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-400/30'
}

function selectClassName(): string {
  return 'frameos-form-control h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-400/30'
}

function setInstallMethodValues(installMethod: FrameInstallMethod): Partial<NewFrameFormType> {
  if (installMethod === 'sd_card') {
    return {
      install_method: installMethod,
      mode: 'buildroot',
      platform: BUILDROOT_RASPBERRY_PI_ZERO_2_W,
      frame_host: '',
    }
  }
  if (installMethod === 'script') {
    return { install_method: installMethod, mode: 'rpios', platform: '', frame_host: '' }
  }
  return { install_method: installMethod, mode: 'rpios', platform: '' }
}

function renderDeviceOptions(): JSX.Element[] {
  return devices.map((group) => (
    <optgroup key={group.label} label={group.label}>
      {group.options.map((device) => (
        <option key={device.value} value={device.value}>
          {device.label}
        </option>
      ))}
    </optgroup>
  ))
}

function renderPlatformOptions(installMethod: FrameInstallMethod): JSX.Element[] {
  const platforms = installMethod === 'sd_card' ? buildrootPlatforms : rpiOSPlatforms
  return platforms.map((platform) => (
    <option key={platform.value} value={platform.value}>
      {platform.label}
    </option>
  ))
}

function installMethodTitle(installMethod: FrameInstallMethod): string {
  if (installMethod === 'sd_card') {
    return 'Download SD card'
  }
  if (installMethod === 'script') {
    return 'Install with a script'
  }
  return 'Install over SSH'
}

export function NewFrame({ headerAction }: { headerAction?: JSX.Element }): JSX.Element {
  const { hideForm, resetNewFrame, setNewFrameValue, setNewFrameValues } = useActions(newFrameForm)
  const { newFrame, newFrameErrors } = useValues(newFrameForm)
  const { savedSettings } = useValues(settingsLogic)
  const installMethod = newFrame.install_method
  const timezone = normalizedTimezone(newFrame.timezone, savedSettings.defaults?.timezone)

  const cancel = () => {
    resetNewFrame()
    hideForm()
  }

  const backToInstallMethods = () => {
    setNewFrameValues({ install_method: undefined })
  }

  return (
    <div className="frameos-form-surface space-y-5 text-slate-900">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="frameos-muted text-xs font-semibold uppercase tracking-wide text-slate-400">Add frame</div>
          <h2 className="frameos-strong mt-1 text-2xl font-bold tracking-normal text-slate-950">
            {installMethod ? installMethodTitle(installMethod) : 'FrameOS'}
          </h2>
        </div>
        {headerAction ? <div className="shrink-0">{headerAction}</div> : null}
      </div>

      {!installMethod ? (
        <div className="space-y-2">
          <div className="frameos-muted text-xs font-semibold uppercase tracking-wide text-slate-400">
            Installation method
          </div>
          <div className="grid grid-cols-1 gap-2">
            <ModeButton
              onClick={() => setNewFrameValues(setInstallMethodValues('sd_card'))}
              title="Download SD card"
              description="Build a flashable Buildroot image."
            >
              <ArrowDownTrayIcon className="h-4 w-4" />
            </ModeButton>
            <ModeButton
              onClick={() => setNewFrameValues(setInstallMethodValues('ssh'))}
              title="Install over SSH"
              description="Deploy to a reachable Raspberry Pi OS host."
            >
              <ServerStackIcon className="h-4 w-4" />
            </ModeButton>
            <ModeButton
              onClick={() => setNewFrameValues(setInstallMethodValues('script'))}
              title="Install with a script"
              description="Run one command on the device."
            >
              <CommandLineIcon className="h-4 w-4" />
            </ModeButton>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={backToInstallMethods}
            className="frameos-secondary-button inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            <ArrowLeftIcon className="h-4 w-4" />
            Back
          </button>
        </div>
      )}

      {installMethod === 'ssh' ? (
        <Form logic={newFrameForm} formKey="newFrame" className="space-y-4" enableFormOnSubmit>
          <p className="frameos-form-hint text-sm leading-relaxed text-slate-500">
            Use SSH when the backend can directly reach the frame on your network.
          </p>
          <FormField label="Name" error={newFrameErrors.name}>
            <input
              className={textInputClassName()}
              value={newFrame.name ?? ''}
              onChange={(event) => setNewFrameValue('name', event.target.value)}
              placeholder="Kitchen Frame"
              required
            />
          </FormField>
          <FormField label="SSH connection string" error={newFrameErrors.frame_host}>
            <input
              className={textInputClassName()}
              value={newFrame.frame_host ?? ''}
              onChange={(event) => setNewFrameValue('frame_host', event.target.value)}
              placeholder="user:pass@127.0.0.1"
              required
            />
          </FormField>
          <FormField
            label="Backend IP or hostname for reverse access"
            hint={
              isLocalServer(newFrame.server_host) ? (
                <span>
                  <span className="font-semibold text-amber-600">Warning:</span> use this server's real host/IP, not
                  localhost. The frame needs to connect back to it.
                </span>
              ) : null
            }
          >
            <input
              className={textInputClassName()}
              value={newFrame.server_host ?? ''}
              onChange={(event) => setNewFrameValue('server_host', event.target.value)}
              placeholder="127.0.0.1"
              required
            />
          </FormField>
          <FormField label="Platform" error={newFrameErrors.platform}>
            <select
              className={selectClassName()}
              value={newFrame.platform ?? ''}
              onChange={(event) => setNewFrameValue('platform', event.target.value)}
            >
              {renderPlatformOptions('ssh')}
            </select>
          </FormField>
          <FormField label="Display driver">
            <select
              className={selectClassName()}
              value={newFrame.device ?? 'web_only'}
              onChange={(event) => setNewFrameValue('device', event.target.value)}
            >
              {renderDeviceOptions()}
            </select>
          </FormField>
          <div className="flex gap-2 pt-2">
            <button
              type="submit"
              className="frameos-primary-action flex h-11 flex-1 items-center justify-center rounded-xl px-4 text-sm font-semibold text-white shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            >
              Add frame
            </button>
            <button
              type="button"
              onClick={cancel}
              className="frameos-secondary-button h-11 rounded-xl bg-slate-100 px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            >
              Cancel
            </button>
          </div>
        </Form>
      ) : installMethod === 'script' ? (
        <Form logic={newFrameForm} formKey="newFrame" className="space-y-4" enableFormOnSubmit>
          <p className="frameos-form-hint text-sm leading-relaxed text-slate-500">
            Use this when SSH is not available. FrameOS will generate a command that installs FrameOS, starts the
            agent, and connects back to this backend.
          </p>
          <FormField label="Name" error={newFrameErrors.name}>
            <input
              className={textInputClassName()}
              value={newFrame.name ?? ''}
              onChange={(event) => setNewFrameValue('name', event.target.value)}
              placeholder="Kitchen Frame"
              required
            />
          </FormField>
          <FormField
            label="Backend IP or hostname for reverse access"
            hint={
              isLocalServer(newFrame.server_host) ? (
                <span>
                  <span className="font-semibold text-amber-600">Warning:</span> use this server's real host/IP, not
                  localhost.
                </span>
              ) : null
            }
          >
            <input
              className={textInputClassName()}
              value={newFrame.server_host ?? ''}
              onChange={(event) => setNewFrameValue('server_host', event.target.value)}
              placeholder="127.0.0.1"
              required
            />
          </FormField>
          <FormField label="Platform" error={newFrameErrors.platform}>
            <select
              className={selectClassName()}
              value={newFrame.platform ?? ''}
              onChange={(event) => setNewFrameValue('platform', event.target.value)}
            >
              {renderPlatformOptions('script')}
            </select>
          </FormField>
          <FormField label="Display driver">
            <select
              className={selectClassName()}
              value={newFrame.device ?? 'web_only'}
              onChange={(event) => setNewFrameValue('device', event.target.value)}
            >
              {renderDeviceOptions()}
            </select>
          </FormField>
          <div className="flex gap-2 pt-2">
            <button
              type="submit"
              className="frameos-primary-action flex h-11 flex-1 items-center justify-center rounded-xl px-4 text-sm font-semibold text-white shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            >
              Add frame
            </button>
            <button
              type="button"
              onClick={cancel}
              className="frameos-secondary-button h-11 rounded-xl bg-slate-100 px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            >
              Cancel
            </button>
          </div>
        </Form>
      ) : installMethod === 'sd_card' ? (
        <Form logic={newFrameForm} formKey="newFrame" className="space-y-4" enableFormOnSubmit>
          <p className="frameos-form-hint text-sm leading-relaxed text-slate-500">
            Buildroot bundles FrameOS into a dedicated firmware image that you can flash to an SD card.
          </p>
          <FormField label="Name" error={newFrameErrors.name}>
            <input
              className={textInputClassName()}
              value={newFrame.name ?? ''}
              onChange={(event) => setNewFrameValue('name', event.target.value)}
              placeholder="Kitchen Frame"
              required
            />
          </FormField>
          <FormField
            label="Backend IP or hostname for reverse access"
            hint={
              isLocalServer(newFrame.server_host) ? (
                <span>
                  <span className="font-semibold text-amber-600">Warning:</span> use this server's real host/IP, not
                  localhost.
                </span>
              ) : null
            }
          >
            <input
              className={textInputClassName()}
              value={newFrame.server_host ?? ''}
              onChange={(event) => setNewFrameValue('server_host', event.target.value)}
              placeholder="127.0.0.1"
              required
            />
          </FormField>
          <FormField label="Platform" error={newFrameErrors.platform}>
            <select
              className={selectClassName()}
              value={newFrame.platform ?? ''}
              onChange={(event) => setNewFrameValue('platform', event.target.value)}
            >
              {renderPlatformOptions('sd_card')}
            </select>
          </FormField>
          <FormField label="Timezone">
            <select
              className={selectClassName()}
              value={timezone}
              onChange={(event) => setNewFrameValue('timezone', event.target.value)}
            >
              {timezoneOptions.map((timezone) => (
                <option key={timezone.value} value={timezone.value}>
                  {timezone.label}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Driver">
            <select
              className={selectClassName()}
              value={newFrame.device ?? 'web_only'}
              onChange={(event) => setNewFrameValue('device', event.target.value)}
            >
              {renderDeviceOptions()}
            </select>
          </FormField>
          <FormField label="WiFi network" error={newFrameErrors.network?.wifiSSID}>
            <input
              className={textInputClassName()}
              value={newFrame.network?.wifiSSID ?? ''}
              onChange={(event) =>
                setNewFrameValue('network', { ...(newFrame.network ?? {}), wifiSSID: event.target.value })
              }
              placeholder="Home WiFi"
              autoComplete="off"
            />
          </FormField>
          <FormField label="WiFi password" error={newFrameErrors.network?.wifiPassword}>
            <input
              className={textInputClassName()}
              value={newFrame.network?.wifiPassword ?? ''}
              onChange={(event) =>
                setNewFrameValue('network', { ...(newFrame.network ?? {}), wifiPassword: event.target.value })
              }
              placeholder="Network password"
              type="password"
              autoComplete="new-password"
            />
          </FormField>
          <div className="flex gap-2 pt-2">
            <button
              type="submit"
              className="frameos-primary-action flex h-11 flex-1 items-center justify-center rounded-xl px-4 text-sm font-semibold text-white shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            >
              Add frame
            </button>
            <button
              type="button"
              onClick={cancel}
              className="frameos-secondary-button h-11 rounded-xl bg-slate-100 px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            >
              Cancel
            </button>
          </div>
        </Form>
      ) : null}
    </div>
  )
}
