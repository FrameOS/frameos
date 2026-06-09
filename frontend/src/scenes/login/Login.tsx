import { Form } from 'kea-forms'
import { Field } from '../../components/Field'
import { TextInput } from '../../components/TextInput'
import { loginLogic } from './loginLogic'
import { useActions, useValues } from 'kea'
import { AuthScreen } from '../auth/AuthScreen'
import { cloudAuthLogic } from '../auth/cloudAuthLogic'
import { CloudArrowUpIcon } from '@heroicons/react/24/outline'

const authInputClassName =
  'frameos-input auth-input h-12 rounded-2xl px-4 py-3 text-base shadow-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-400'

export function Login() {
  const { isLoginFormSubmitting } = useValues(loginLogic)
  const { cloudAuthStatus, cloudAuthStatusLoading } = useValues(cloudAuthLogic)
  const { continueWithCloudAuth } = useActions(cloudAuthLogic)
  return (
    <AuthScreen title="Log in">
      <>
        {cloudAuthStatus.provider_enabled ? (
          <button
            disabled={cloudAuthStatusLoading}
            type="button"
            onClick={() => continueWithCloudAuth('login')}
            className="auth-button auth-cloud-button group relative flex min-h-[3.25rem] w-full items-center justify-center gap-3 rounded-2xl px-4 py-2.5 text-sm font-semibold shadow-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="auth-cloud-icon relative z-10 flex h-8 w-8 items-center justify-center rounded-xl">
              <CloudArrowUpIcon className="h-5 w-5" />
            </span>
            <span className="relative z-10 min-w-0 leading-tight">Log in with FrameOS Cloud Auth</span>
          </button>
        ) : null}
        {cloudAuthStatus.provider_enabled ? (
          <div className="auth-local-divider flex items-center gap-3 text-xs font-semibold uppercase tracking-wide">
            <div className="auth-local-divider-line h-px flex-1" />
            <span>or login locally</span>
            <div className="auth-local-divider-line h-px flex-1" />
          </div>
        ) : null}
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
      </>
    </AuthScreen>
  )
}

export default Login
