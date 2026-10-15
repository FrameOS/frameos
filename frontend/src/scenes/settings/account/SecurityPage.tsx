import { useActions, useValues } from 'kea'
import { Form } from 'kea-forms'
import { ArrowDownTrayIcon, TrashIcon } from '@heroicons/react/24/outline'

import { Box } from '../../../components/Box'
import { Button } from '../../../components/Button'
import { Field } from '../../../components/Field'
import { Spinner } from '../../../components/Spinner'
import { TextInput } from '../../../components/TextInput'
import { urls } from '../../../urls'
import { AccountNotice, AccountPageHeader, AccountSection } from './AccountPageHeader'
import { securityLogic } from './securityLogic'
import { TwoFactorSettings } from './TwoFactorSettings'

function PasswordCard(): JSX.Element {
  const { security, passwordDone, passwordError, isPasswordSubmitting } = useValues(securityLogic)
  if (!security?.has_password) {
    return (
      <Box className="p-4 text-sm leading-relaxed">
        This account signs in without a password (e.g. with Google). To add one, use the{' '}
        <a className="frameos-link hover:underline" href="/reset">
          password reset flow
        </a>
        . The emailed link proves you control the address.
      </Box>
    )
  }
  return (
    <Box className="p-4">
      <Form logic={securityLogic} formKey="password" enableFormOnSubmit className="max-w-md space-y-3">
        {passwordError ? <AccountNotice tone="error">{passwordError}</AccountNotice> : null}
        {passwordDone ? (
          <AccountNotice tone="success">Password changed. Other signed-in sessions were signed out.</AccountNotice>
        ) : null}
        <Field name="current_password" label="Current password">
          <TextInput type="password" autoComplete="current-password" />
        </Field>
        <Field name="new_password" label="New password">
          <TextInput type="password" autoComplete="new-password" />
        </Field>
        <div className="flex justify-end">
          <Button type="submit" size="small" color="primary" disabled={isPasswordSubmitting}>
            {isPasswordSubmitting ? 'Changing…' : 'Change password'}
          </Button>
        </div>
      </Form>
    </Box>
  )
}

function SessionsCard(): JSX.Element {
  const { signOutState, signOutRevoked, signOutError } = useValues(securityLogic)
  const { signOutEverywhere } = useActions(securityLogic)
  return (
    <Box className="space-y-3 p-4">
      {signOutError ? <AccountNotice tone="error">{signOutError}</AccountNotice> : null}
      {signOutState === 'done' ? (
        <p className="text-sm" role="status">
          {signOutRevoked === 0
            ? 'No other sessions were signed in.'
            : `Signed out ${signOutRevoked} other session${signOutRevoked === 1 ? '' : 's'}. This one stays.`}
        </p>
      ) : null}
      <Button
        size="small"
        color="secondary"
        disabled={signOutState === 'submitting'}
        onClick={() => signOutEverywhere()}
      >
        {signOutState === 'submitting' ? 'Signing out…' : 'Sign out everywhere else'}
      </Button>
    </Box>
  )
}

// Self-serve erasure. Two deliberate frictions and no more: you have to open
// the form, and you have to prove it is you (the password, or re-auth). No
// "type DELETE to confirm" theatre on top.
function DeleteAccountCard(): JSX.Element {
  const { security, deleteOpen, deleteError, isDeleteAccountSubmitting } = useValues(securityLogic)
  const { setDeleteOpen } = useActions(securityLogic)
  if (security?.is_superadmin) {
    return (
      <Box className="p-4 text-sm leading-relaxed">
        This account is a superadmin. Hand the superadmin flag to someone else (or have another superadmin remove yours)
        before deleting it. The admin panel must never end up with no way in.
      </Box>
    )
  }
  if (!deleteOpen) {
    return (
      <Box className="p-4">
        <Button size="small" color="red" onClick={() => setDeleteOpen(true)} className="inline-flex items-center gap-1">
          <TrashIcon className="h-4 w-4" />
          Delete my account
        </Button>
      </Box>
    )
  }
  return (
    <Box className="p-4">
      <Form logic={securityLogic} formKey="deleteAccount" enableFormOnSubmit className="max-w-md space-y-3">
        {deleteError ? <AccountNotice tone="error">{deleteError}</AccountNotice> : null}
        <p className="text-sm leading-relaxed">
          This permanently deletes your account, your frames, your scenes (including any you have published to the
          store), your uploaded files and your backups. It happens immediately and cannot be undone. Off-site backups
          roll over within 30 days.
        </p>
        <p className="text-sm leading-relaxed">
          <strong>Export your data first</strong> if you want a copy. The button is right above this one.
        </p>
        {security?.has_password ? (
          <Field name="password" label="Confirm your password">
            <TextInput type="password" autoComplete="current-password" />
          </Field>
        ) : (
          <Field
            name="confirm_email"
            label={
              <>
                Type <strong>{security?.email}</strong> to confirm
              </>
            }
          >
            <TextInput type="email" autoComplete="off" />
          </Field>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="small" color="secondary" onClick={() => setDeleteOpen(false)}>
            Cancel
          </Button>
          <Button type="submit" size="small" color="red" disabled={isDeleteAccountSubmitting}>
            {isDeleteAccountSubmitting ? 'Deleting…' : 'Delete my account permanently'}
          </Button>
        </div>
      </Form>
    </Box>
  )
}

export function SecurityPage(): JSX.Element {
  const { security, securityLoading } = useValues(securityLogic)
  if (!security && securityLoading) {
    return (
      <div>
        <AccountPageHeader page="security" />
        <Spinner />
      </div>
    )
  }
  return (
    <div className="space-y-8">
      <AccountPageHeader page="security" />
      <AccountSection title="Password" description="Changing your password signs out every other session.">
        <PasswordCard />
      </AccountSection>
      <AccountSection
        title="Sessions"
        description={
          <>
            Left a laptop signed in somewhere? Sign out every other browser and device at once; this session stays.
            Personal API tokens are separate: revoke those on the{' '}
            <a className="frameos-link hover:underline" href={urls.settings('developer')}>
              Developer
            </a>{' '}
            page.
          </>
        }
      >
        <SessionsCard />
      </AccountSection>
      <AccountSection
        title="Two-factor authentication"
        description="Optional, and recommended for an account that controls physical frames: add an authenticator app or a passkey and sign-in asks for it after your password or Google."
      >
        <Box className="p-4">
          <TwoFactorSettings />
        </Box>
      </AccountSection>
      {/* GDPR arts. 15/17/20 in two buttons. Both are deliberately here on the
          security page rather than buried in a support email: a right you have
          to ask a human for is a right with a queue in front of it. */}
      <AccountSection
        title="Your data"
        description={
          <>
            Take a copy of everything on this account, or close it for good. What we store and why is in our{' '}
            <a className="frameos-link hover:underline" href="/legal/privacy">
              Privacy Policy
            </a>
            .
          </>
        }
      >
        <Box className="space-y-3 p-4">
          <h3 className="frameos-strong font-semibold">Export</h3>
          <p className="frameos-muted text-sm leading-relaxed">
            Downloads a JSON file with your account, frames, scenes, settings, chats and security history. Binary files
            (scene zips, images, backups) are listed with a download link rather than embedded.
          </p>
          <a
            className="frameos-button frameos-secondary-button inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm"
            download
            href="/api/account/export"
          >
            <ArrowDownTrayIcon className="h-4 w-4" />
            Download my data
          </a>
        </Box>
      </AccountSection>
      <AccountSection
        title="Delete account"
        description="Permanent, immediate, and entirely up to you. No support ticket involved."
      >
        <DeleteAccountCard />
      </AccountSection>
    </div>
  )
}
