import { actions, afterMount, kea, listeners, path, reducers } from 'kea'
import { forms } from 'kea-forms'
import type { signupLogicType } from './signupLogicType'
import { urls } from '../../urls'
import { userExists } from '../../utils/apiFetch'

export interface SignupForm {
  email: string
  password: string
  password2: string
  newsletter: boolean
}

export const signupLogic = kea<signupLogicType>([
  path(['src', 'scenes', 'signup', 'signupLogic']),
  actions({
    cloudSignup: true,
    setIsCloudSignupSubmitting: (isSubmitting: boolean) => ({ isSubmitting }),
  }),
  reducers({
    isCloudSignupSubmitting: [
      false,
      {
        setIsCloudSignupSubmitting: (_, { isSubmitting }) => isSubmitting,
      },
    ],
  }),
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
            window.location.href = urls.frames()
          } else {
            let errors = {}
            try {
              const json = await response.json()
              if (json.errors) {
                errors = json.errors
              } else if (json.error) {
                errors = { password2: json.error }
              } else if (Array.isArray(json.detail)) {
                const message = json.detail
                  .map((detail: { msg?: string }) => detail?.msg)
                  .filter(Boolean)
                  .join(' ')
                errors = { password2: message || response.statusText }
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
  afterMount(async ({ actions }) => {
    if (await userExists()) {
      window.location.href = urls.login()
    }
  }),
  listeners(({ values, actions }) => ({
    cloudSignup: async () => {
      actions.setIsCloudSignupSubmitting(true)
      try {
        const { email, password, password2, newsletter } = values.signupForm
        const response = await fetch(`/api/cloud/signup/start`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-FrameOS-Return-To': new URL(urls.frames(), window.location.origin).toString(),
          },
          body: JSON.stringify({ email, password, password2, newsletter }),
        })
        const json = await response.json().catch(() => ({}))
        if (response.ok && json.cloud_auth_url) {
          window.location.href = json.cloud_auth_url
          return
        }
        actions.setSignupFormManualErrors({
          password2: json.detail || json.error || response.statusText || 'Could not start cloud signup.',
        })
      } catch (error) {
        console.error(error)
        actions.setSignupFormManualErrors({ password2: 'An unexpected error occurred.' })
      } finally {
        actions.setIsCloudSignupSubmitting(false)
      }
    },
  })),
])
