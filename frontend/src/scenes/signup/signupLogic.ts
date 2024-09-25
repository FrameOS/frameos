import { kea, path } from 'kea'
import { forms } from 'kea-forms'
import type { signupLogicType } from './signupLogicType'

export interface SignupForm {
  email: string
  password: string
  password2: string
  newsletter: boolean
}

export const signupLogic = kea<signupLogicType>([
  path(['src', 'scenes', 'signup', 'signupLogic']),
  forms(({ actions }) => ({
    signupForm: {
      defaults: {
        email: '',
        password: '',
        password2: '',
        newsletter: false,
      } as SignupForm,
      options: {
        showErrorsOnTouch: true,
        canSubmitWithErrors: true,
      },
      errors: (formData: Partial<SignupForm>) => ({
        email: !formData.email ? 'Please enter an email address' : null,
        password: !formData.password ? 'Please enter a password' : null,
        password2: formData.password !== formData.password2 ? 'Passwords do not match' : null,
      }),
      submit: async (formData) => {
        try {
          const { email, password, password2 } = formData
          const response = await fetch(`/api/signup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, password2 }),
          })
          if (response.ok) {
            const response = await fetch(`/api/login`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email, password }),
            })
            window.location.href = '/'
          } else {
            let errors: Record<string, string> = {}
            try {
              const json = await response.json()
              if (json.errors) {
                errors = json.errors
              } else if (json.error) {
                errors = { password2: json.error }
              }
            } catch (e) {
              errors = { password2: response.statusText }
            }
            actions.setSignupFormManualErrors(errors)
          }
        } catch (error) {
          console.error(error)
          actions.setSignupFormManualErrors({ password2: 'An unexpected error occurred.' })
        }
      },
    },
  })),
])
