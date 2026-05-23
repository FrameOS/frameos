import { Form } from 'kea-forms'
import { Field } from '../../components/Field'
import { TextInput } from '../../components/TextInput'
import { loginLogic } from './loginLogic'
import { useValues } from 'kea'
import { AuthScreen } from '../auth/AuthScreen'

const authInputClassName =
  'frameos-input auth-input h-12 rounded-2xl px-4 py-3 text-base shadow-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-400'

export function Login() {
  const { isLoginFormSubmitting } = useValues(loginLogic)
  return (
    <AuthScreen title="Log in">
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
          className="frameos-primary-action auth-button flex h-12 w-full items-center justify-center rounded-full px-5 text-sm font-semibold text-white shadow-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Log in
        </button>
      </Form>
    </AuthScreen>
  )
}

export default Login
