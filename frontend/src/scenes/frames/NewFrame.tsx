import { Form } from 'kea-forms'
import { useActions, useValues } from 'kea'
import clsx from 'clsx'
import { ArrowUpTrayIcon, CpuChipIcon, EllipsisHorizontalIcon } from '@heroicons/react/24/outline'
import { BUILDROOT_RASPBERRY_PI_ZERO_2_W, devices, buildrootPlatforms } from '../../devices'
import { A } from 'kea-router'
import { urls } from '../../urls'
import { Spinner } from '../../components/Spinner'
import { newFrameForm } from './newFrameForm'
import { NewFrameFormType } from '../../types'

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
  active,
  children,
  onClick,
}: {
  active: boolean
  children: JSX.Element | string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'frameos-segment flex min-h-10 flex-1 items-center justify-center rounded-xl px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
        active ? 'frameos-primary-active text-white shadow-sm' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
      )}
    >
      {children}
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

function setModeValues(mode: NewFrameFormType['mode']): Partial<NewFrameFormType> {
  if (mode === 'buildroot') {
    return { mode, platform: BUILDROOT_RASPBERRY_PI_ZERO_2_W, frame_host: '' }
  }
  if (mode === 'import') {
    return { mode }
  }
  return { mode, platform: null }
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

export function NewFrame({ headerAction }: { headerAction?: JSX.Element }): JSX.Element {
  const { hideForm, resetNewFrame, setNewFrameValue, setNewFrameValues, setFile, importFrame } =
    useActions(newFrameForm)
  const { newFrame, newFrameErrors, file, importingFrameLoading } = useValues(newFrameForm)
  const mode = newFrame.mode

  const cancel = () => {
    setFile(null)
    resetNewFrame()
    hideForm()
  }

  return (
    <div className="frameos-form-surface space-y-5 text-slate-900">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="frameos-muted text-xs font-semibold uppercase tracking-wide text-slate-400">FrameOS</div>
          <h2 className="frameos-strong mt-1 text-2xl font-bold tracking-normal text-slate-950">Add frame</h2>
        </div>
        {headerAction ? <div className="shrink-0">{headerAction}</div> : null}
      </div>

      <div className="frameos-segment-group flex rounded-2xl bg-slate-100 p-1">
        <ModeButton active={mode === 'rpios'} onClick={() => setNewFrameValues(setModeValues('rpios'))}>
          <span className="inline-flex items-center gap-2">
            <CpuChipIcon className="h-4 w-4" />
            RPi OS
          </span>
        </ModeButton>
        <ModeButton active={mode === 'import'} onClick={() => setNewFrameValues(setModeValues('import'))}>
          <span className="inline-flex items-center gap-2">
            <ArrowUpTrayIcon className="h-4 w-4" />
            Import
          </span>
        </ModeButton>
        <ModeButton active={mode === 'buildroot'} onClick={() => setNewFrameValues(setModeValues('buildroot'))}>
          <span className="inline-flex items-center gap-2">
            <EllipsisHorizontalIcon className="h-4 w-4" />
            Buildroot
          </span>
        </ModeButton>
      </div>

      {mode === 'rpios' ? (
        <Form logic={newFrameForm} formKey="newFrame" className="space-y-4" enableFormOnSubmit>
          <p className="frameos-form-hint text-sm leading-relaxed text-slate-500">
            Enter the credentials for a running Raspberry Pi OS Lite machine. FrameOS will deploy over SSH.
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
            label={
              <>
                SSH connection string{' '}
                <A href={urls.settings()} className="frameos-link hover:underline">
                  setup keys
                </A>
              </>
            }
            error={newFrameErrors.frame_host}
          >
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
      ) : mode === 'buildroot' ? (
        <Form logic={newFrameForm} formKey="newFrame" className="space-y-4" enableFormOnSubmit>
          <p className="frameos-form-hint text-sm leading-relaxed text-slate-500">
            Buildroot bundles FrameOS into a dedicated firmware image. Support is still evolving.
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
          <FormField label="Driver">
            <select
              className={selectClassName()}
              value={newFrame.device ?? 'web_only'}
              onChange={(event) => setNewFrameValue('device', event.target.value)}
            >
              {renderDeviceOptions()}
            </select>
          </FormField>
          <FormField label="Platform" error={newFrameErrors.platform}>
            <select
              className={selectClassName()}
              value={newFrame.platform ?? ''}
              onChange={(event) => setNewFrameValue('platform', event.target.value)}
            >
              {buildrootPlatforms.map((platform) => (
                <option key={platform.value} value={platform.value}>
                  {platform.label}
                </option>
              ))}
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
              required
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
              required
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
      ) : (
        <div className="space-y-4">
          <label className="frameos-import-target flex min-h-36 cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center transition hover:bg-slate-100">
            <ArrowUpTrayIcon className="mb-2 h-8 w-8 text-slate-400" />
            <span className="frameos-strong text-sm font-semibold text-slate-800">
              {file ? file.name : 'Choose frame JSON'}
            </span>
            <span className="frameos-muted mt-1 text-xs text-slate-500">Import a previously exported frame.</span>
            <input
              type="file"
              accept=".json"
              className="sr-only"
              onChange={(event) => setFile(event.target.files?.[0] || null)}
            />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={importFrame}
              disabled={!file || importingFrameLoading}
              className="frameos-primary-action flex h-11 flex-1 items-center justify-center rounded-xl px-4 text-sm font-semibold text-white shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {importingFrameLoading ? <Spinner color="white" /> : 'Import'}
            </button>
            <button
              type="button"
              onClick={cancel}
              className="frameos-secondary-button h-11 rounded-xl bg-slate-100 px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
