import { Form } from 'kea-forms'
import { Field } from '../../components/Field'
import { TextInput } from '../../components/TextInput'
import { loginLogic } from './loginLogic'
import { useActions, useValues } from 'kea'
import { AuthScreen } from '../auth/AuthScreen'
import { cloudLoginErrorMessage, cloudLoginLogic } from '../auth/cloudLoginLogic'

const authInputClassName =
  'frameos-input auth-input h-12 rounded-2xl px-4 py-3 text-base shadow-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-400'

export function Login() {
  const { isLoginFormSubmitting } = useValues(loginLogic)
  const { cloudLoginAvailable, localLoginEnabled, cloudLoginError, isCloudLoginStarting } = useValues(cloudLoginLogic)
  const { startCloudLogin } = useActions(cloudLoginLogic)

  return (
    <AuthScreen title="Log in">
      <div className="space-y-4">
        {cloudLoginError ? (
          <div className="rounded-xl border border-red-400/40 bg-red-500/10 px-4 py-3 text-sm text-red-500">
            {cloudLoginErrorMessage(cloudLoginError)}
          </div>
        ) : null}
        {cloudLoginAvailable ? (
          <>
            <button
              type="button"
              onClick={() => startCloudLogin()}
              disabled={isCloudLoginStarting}
              className="frameos-primary-action auth-button flex h-12 w-full items-center justify-center rounded-xl px-5 text-sm font-semibold text-white shadow-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Continue with FrameOS Cloud
            </button>
            {localLoginEnabled ? (
              <div className="frameos-muted flex items-center gap-3 text-xs uppercase tracking-wide">
                <span className="h-px flex-1 bg-current opacity-20" />
                or
                <span className="h-px flex-1 bg-current opacity-20" />
              </div>
            ) : null}
          </>
        ) : null}
        {localLoginEnabled ? (
          <Form logic={loginLogic} formKey="loginForm" className="space-y-4" enableFormOnSubmit>
            <Field name="email" label="Email" className="auth-field">
              <TextInput
                name="email"
                placeholder="email@example.com"
                type="email"
                autoComplete="email"
                className={authInputClassName}
                required
              />
            </Field>
            <Field name="password" label="Password" className="auth-field">
              <TextInput
                name="password"
                placeholder="Password"
                type="password"
                autoComplete="current-password"
                className={authInputClassName}
                required
              />
            </Field>
            <button
              disabled={isLoginFormSubmitting}
              type="submit"
              className="frameos-primary-action auth-button flex h-12 w-full items-center justify-center rounded-xl px-5 text-sm font-semibold text-white shadow-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Log in
            </button>
          </Form>
        ) : (
          <div className="frameos-muted text-sm">
            Local password login is disabled on this install. Use FrameOS Cloud to sign in.
          </div>
        )}
      </div>
    </AuthScreen>
  )
}

export default Login
