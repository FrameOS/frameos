import { Form } from 'kea-forms'
import { Field } from '../../components/Field'
import { TextInput } from '../../components/TextInput'
import { signupLogic } from './signupLogic'
import { signupCloudLogic } from './signupCloudLogic'
import { useActions, useValues } from 'kea'
import { AuthScreen, AuthLink } from '../auth/AuthScreen'
import { cloudLoginErrorMessage, cloudLoginLogic } from '../auth/cloudLoginLogic'
import { urls } from '../../urls'

/** First-run cloud option: link this install to FrameOS Cloud and create the
 * first user from the approving cloud account — or restore a previous setup. */
function SignupCloudSection(): JSX.Element | null {
  const { setupCloudStatus, setupCloudError, isSetupCloudConnecting } = useValues(signupCloudLogic)
  const { connectSetupCloud, cancelSetupCloud } = useActions(signupCloudLogic)
  const { isCloudLoginStarting, cloudLoginError } = useValues(cloudLoginLogic)
  const { startCloudLogin } = useActions(cloudLoginLogic)

  if (!setupCloudStatus || !setupCloudStatus.enabled) {
    return null
  }
  const providerHost = (setupCloudStatus.provider_url ?? 'cloud.frameos.net').replace(/^https?:\/\//, '')
  const connection = setupCloudStatus.connection

  return (
    <div className="space-y-4 pt-2">
      <div className="frameos-muted flex items-center gap-3 text-xs uppercase tracking-wide">
        <span className="h-px flex-1 bg-current opacity-20" />
        or
        <span className="h-px flex-1 bg-current opacity-20" />
      </div>
      {cloudLoginError ? (
        <div className="rounded-xl border border-red-400/40 bg-red-500/10 px-4 py-3 text-sm text-red-500">
          {cloudLoginErrorMessage(cloudLoginError)}
        </div>
      ) : null}
      {setupCloudStatus.status === 'connected' ? (
        <button
          type="button"
          onClick={() => startCloudLogin()}
          disabled={isCloudLoginStarting}
          className="frameos-secondary-action auth-button flex h-12 w-full items-center justify-center rounded-xl px-5 text-sm font-semibold shadow-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Continue with FrameOS Cloud
        </button>
      ) : setupCloudStatus.status === 'connecting' && connection ? (
        <div className="space-y-2 text-sm">
          <div className="frameos-muted">Enter this code on the approval page to link this install:</div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="frameos-strong select-all font-mono text-2xl font-bold tracking-widest">
              {connection.user_code}
            </span>
            <button
              type="button"
              onClick={() =>
                window.open(
                  connection.verification_uri_complete ?? connection.verification_uri ?? undefined,
                  '_blank',
                  'noopener'
                )
              }
              className="frameos-link font-semibold hover:underline"
            >
              Open {providerHost}
            </button>
          </div>
          <div className="frameos-muted">
            Waiting for approval…{' '}
            <button type="button" onClick={cancelSetupCloud} className="frameos-link font-semibold hover:underline">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={connectSetupCloud}
          disabled={isSetupCloudConnecting}
          className="frameos-secondary-action auth-button flex h-12 w-full items-center justify-center rounded-xl px-5 text-sm font-semibold shadow-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Continue with FrameOS Cloud
        </button>
      )}
      {setupCloudError ? <div className="text-sm text-red-500">{setupCloudError}</div> : null}
      <div className="frameos-muted text-xs">
        Links this install to your {providerHost} account, signs you in with it, and lets you restore cloud backups of a
        previous install. A local account keeps working either way.
      </div>
    </div>
  )
}

const authInputClassName =
  'frameos-input auth-input h-12 rounded-2xl px-4 py-3 text-base shadow-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-400'

export function Signup() {
  const { isSignupFormSubmitting } = useValues(signupLogic)
  return (
    <AuthScreen
      title="Create account"
      subtitle="Set up the first FrameOS user for this installation."
      footer={
        <>
          Already configured? <AuthLink href={urls.login()}>Log in</AuthLink>
        </>
      }
    >
      <>
        <Form logic={signupLogic} formKey="signupForm" className="space-y-4" enableFormOnSubmit>
          <Field name="email" label="Email" className="auth-field">
            <TextInput
              name="email"
              placeholder="email@example.com"
              autoComplete="email"
              type="email"
              className={authInputClassName}
              required
            />
          </Field>
          <Field name="password" label="Password" className="auth-field">
            <TextInput
              name="password"
              placeholder="Password"
              type="password"
              required
              autoComplete="new-password"
              className={authInputClassName}
            />
          </Field>
          <Field name="password2" label="Confirm password" className="auth-field">
            <TextInput
              name="password2"
              placeholder="Confirm password"
              type="password"
              required
              autoComplete="new-password"
              className={authInputClassName}
            />
          </Field>
          <button
            disabled={isSignupFormSubmitting}
            type="submit"
            className="frameos-primary-action auth-button flex h-12 w-full items-center justify-center rounded-xl px-5 text-sm font-semibold text-white shadow-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Create account
          </button>
        </Form>
        <SignupCloudSection />
      </>
    </AuthScreen>
  )
}

export default Signup
