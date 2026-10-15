import { useActions, useValues } from 'kea'
import { ClipboardDocumentIcon, KeyIcon, PlusIcon, ShieldCheckIcon, TrashIcon } from '@heroicons/react/24/outline'

import { Box } from '../../../components/Box'
import { Button } from '../../../components/Button'
import { Spinner } from '../../../components/Spinner'
import { Tag } from '../../../components/Tag'
import { TextInput } from '../../../components/TextInput'
import { AccountNotice, AccountTable } from './AccountPageHeader'
import { formatDateTimeOrNever } from './format'
import { twoFactorLogic } from './twoFactorLogic'

// The two-factor card of the Security page (twoFactorLogic.ts): status,
// the authenticator app, the passkeys, the recovery codes and the off
// switch. Every weakening action asks for a proof inline (the password, or a
// current code), right where the action is.
export function TwoFactorSettings(): JSX.Element {
  const {
    status,
    statusLoaded,
    statusLoading,
    error,
    notice,
    busy,
    totpSetup,
    totpCode,
    recoveryCodes,
    pendingProof,
    proofValue,
    newPasskeyName,
    renaming,
  } = useValues(twoFactorLogic)
  const {
    startTotp,
    confirmTotp,
    cancelTotpSetup,
    setTotpCode,
    removeTotp,
    addPasskey,
    removePasskey,
    setNewPasskeyName,
    setRenaming,
    savePasskeyName,
    regenerateRecoveryCodes,
    disableAll,
    submitProof,
    cancelProof,
    setProofValue,
    copyRecoveryCodes,
    dismissRecoveryCodes,
  } = useActions(twoFactorLogic)

  if (!statusLoaded && statusLoading) {
    return <Spinner />
  }

  return (
    <div className="space-y-5">
      <div>
        <Tag color={status.enabled ? 'teal' : 'gray'} className="inline-flex items-center gap-1 px-2 py-1">
          <ShieldCheckIcon className="h-3.5 w-3.5" />
          {status.enabled ? 'Two-factor on' : 'Two-factor off'}
        </Tag>
      </div>

      {error ? <AccountNotice tone="error">{error}</AccountNotice> : null}
      {notice ? <AccountNotice tone="success">{notice}</AccountNotice> : null}

      {recoveryCodes ? (
        <Box className="space-y-3 p-4">
          <h3 className="frameos-strong font-semibold">Save your recovery codes</h3>
          <p className="frameos-muted text-sm leading-relaxed">
            Each code signs you in once if you lose your authenticator or passkeys. They are shown only now. Store them
            somewhere safe.
          </p>
          <pre className="frameos-inset select-all rounded-lg border p-3 font-mono text-sm leading-relaxed">
            {recoveryCodes.join('\n')}
          </pre>
          <div className="flex flex-wrap gap-2">
            <Button
              size="small"
              color="secondary"
              onClick={copyRecoveryCodes}
              className="inline-flex items-center gap-1"
            >
              <ClipboardDocumentIcon className="h-4 w-4" />
              Copy
            </Button>
            <Button size="small" color="secondary" onClick={dismissRecoveryCodes}>
              I saved them
            </Button>
          </div>
        </Box>
      ) : null}

      {pendingProof ? (
        <form
          className="frameos-inset space-y-3 rounded-lg border p-4"
          onSubmit={(event) => {
            event.preventDefault()
            submitProof()
          }}
        >
          <h3 className="frameos-strong font-semibold">{pendingProof.label}</h3>
          <p className="frameos-muted text-sm">
            {status.has_password
              ? 'Confirm your password to continue.'
              : 'Enter a current authenticator code or a recovery code to continue.'}
          </p>
          <label className="block space-y-1 text-sm">
            <span className="frameos-form-label font-medium">{status.has_password ? 'Password' : 'Code'}</span>
            <TextInput
              autoComplete={status.has_password ? 'current-password' : 'one-time-code'}
              autoFocus
              required={status.has_password || status.totp_enabled}
              type={status.has_password ? 'password' : 'text'}
              value={proofValue}
              onChange={(value) => setProofValue(value)}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              size="small"
              color={pendingProof.tone === 'primary' ? 'primary' : 'red'}
              disabled={busy}
            >
              Continue
            </Button>
            <Button size="small" color="secondary" onClick={cancelProof}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      <section className="space-y-2">
        <h3 className="frameos-strong font-semibold">Authenticator app</h3>
        {status.totp_enabled ? (
          <div className="flex flex-wrap items-center gap-2">
            <Tag color="teal">Enabled</Tag>
            <Button
              size="small"
              color="secondary"
              disabled={busy}
              onClick={removeTotp}
              className="inline-flex items-center gap-1"
            >
              <TrashIcon className="h-4 w-4" /> Remove
            </Button>
          </div>
        ) : totpSetup ? (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              confirmTotp()
            }}
          >
            <p className="frameos-muted text-sm">
              Scan this with Google Authenticator, 1Password, Authy or any TOTP app, then enter the six-digit code it
              shows.
            </p>
            <div
              aria-label="QR code for the authenticator app"
              role="img"
              className="inline-block rounded-lg bg-white p-2 [&_svg]:h-44 [&_svg]:w-44"
              // Server-generated SVG from the qrcode library, never user input.
              dangerouslySetInnerHTML={{ __html: totpSetup.qr_svg }}
            />
            <p className="frameos-muted text-sm">
              Can't scan? Enter this key by hand: <code className="select-all font-mono">{totpSetup.secret}</code>
            </p>
            <label className="block max-w-xs space-y-1 text-sm">
              <span className="frameos-form-label font-medium">Six-digit code</span>
              <TextInput
                autoComplete="one-time-code"
                inputMode="numeric"
                placeholder="123 456"
                required
                value={totpCode}
                onChange={(value) => setTotpCode(value)}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="small" color="primary" disabled={busy}>
                Turn on
              </Button>
              <Button size="small" color="secondary" onClick={cancelTotpSetup}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <p className="frameos-muted text-sm">
              Six-digit codes from an app on your phone, as a second step after your password.
            </p>
            <Button
              size="small"
              color="secondary"
              disabled={busy}
              onClick={startTotp}
              className="inline-flex items-center gap-1"
            >
              <PlusIcon className="h-4 w-4" /> Set up
            </Button>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="frameos-strong font-semibold">Passkeys</h3>
        <p className="frameos-muted text-sm leading-relaxed">
          Face ID, Touch ID, Windows Hello or a security key. A passkey works as a second step, and one with screen-lock
          verification can sign you in without a password at all.
        </p>
        {status.passkeys.length > 0 ? (
          <AccountTable head={['Name', 'Added', 'Last used', '']}>
            {status.passkeys.map((passkey) => (
              <tr key={passkey.id}>
                <td className="py-2 pr-3 align-top">
                  {renaming?.id === passkey.id ? (
                    <form
                      className="flex flex-wrap items-center gap-2"
                      onSubmit={(event) => {
                        event.preventDefault()
                        savePasskeyName()
                      }}
                    >
                      <TextInput
                        aria-label="Passkey name"
                        className="w-48"
                        maxLength={64}
                        value={renaming.name}
                        onChange={(value) => setRenaming({ id: passkey.id, name: value })}
                      />
                      <Button type="submit" size="tiny" color="primary">
                        Save
                      </Button>
                      <Button size="tiny" color="secondary" onClick={() => setRenaming(null)}>
                        Cancel
                      </Button>
                    </form>
                  ) : (
                    <span className="inline-flex items-center gap-2">
                      <KeyIcon className="h-4 w-4" />
                      {passkey.name}
                      {passkey.backed_up ? <Tag>synced</Tag> : null}
                    </span>
                  )}
                </td>
                <td className="py-2 pr-3 align-top">{formatDateTimeOrNever(passkey.created_at)}</td>
                <td className="py-2 pr-3 align-top">{formatDateTimeOrNever(passkey.last_used_at)}</td>
                <td className="py-2 align-top">
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      size="tiny"
                      color="secondary"
                      onClick={() => setRenaming({ id: passkey.id, name: passkey.name })}
                    >
                      Rename
                    </Button>
                    <Button
                      size="tiny"
                      color="secondary"
                      disabled={busy}
                      onClick={() => removePasskey(passkey.id, passkey.name)}
                    >
                      Remove
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </AccountTable>
        ) : null}
        <div className="flex flex-wrap items-end gap-2">
          <label className="block space-y-1 text-sm">
            <span className="frameos-form-label font-medium">Name for the new passkey</span>
            <TextInput
              className="w-64"
              maxLength={64}
              placeholder="e.g. MacBook Touch ID"
              value={newPasskeyName}
              onChange={(value) => setNewPasskeyName(value)}
            />
          </label>
          <Button
            size="small"
            color="secondary"
            disabled={busy}
            onClick={addPasskey}
            className="inline-flex items-center gap-1"
          >
            <PlusIcon className="h-4 w-4" /> Add a passkey
          </Button>
        </div>
      </section>

      {status.enabled ? (
        <section className="space-y-2">
          <h3 className="frameos-strong font-semibold">Recovery codes</h3>
          <p className="frameos-muted text-sm leading-relaxed">
            {status.recovery_codes_remaining} unused recovery {status.recovery_codes_remaining === 1 ? 'code' : 'codes'}{' '}
            left. Each one signs you in once when your authenticator or passkeys are out of reach.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="small" color="secondary" disabled={busy} onClick={regenerateRecoveryCodes}>
              Generate new codes
            </Button>
            <Button size="small" color="secondary" disabled={busy} onClick={disableAll}>
              Turn off two-factor
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  )
}
