import { Form } from 'kea-forms'
import { Field } from '../../components/Field'
import { TextInput } from '../../components/TextInput'
import { signupLogic } from './signupLogic'
import { useValues } from 'kea'
import { AuthScreen, AuthLink } from '../auth/AuthScreen'
import { urls } from '../../urls'

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
          className="frameos-primary-action auth-button flex h-12 w-full items-center justify-center rounded-full px-5 text-sm font-semibold text-white shadow-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Create account
        </button>
      </Form>
    </AuthScreen>
  )
}

export default Signup
