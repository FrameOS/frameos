import { kea, path } from 'kea'
import { forms } from 'kea-forms'
import type { signupLogicType } from './signupLogicType'
import { urls } from '../../urls'

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
          const { email, password, password2, newsletter } = formData
          const response = await fetch(`/api/signup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, password2, newsletter }),
          })
          if (response.ok) {
            const json = await response.json()
            localStorage.setItem('token', json.access_token)
            window.location.href = urls.frames()
          } else {
            let errors = {}
            try {
              const json = await response.json()
              if (json.errors) {
                errors = json.errors
              } else if (json.error) {
                errors = { password2: json.error }
              } else if (json.detail) {
                errors = { password2: json.detail }
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
