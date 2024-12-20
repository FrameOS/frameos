import { kea, path } from 'kea'

import { forms } from 'kea-forms'

import type { loginLogicType } from './loginLogicType'

export interface LoginLogicForm {
  email: string
  password: string
}

export const loginLogic = kea<loginLogicType>([
  path(['src', 'scenes', 'login', 'loginForm']),
  forms(({ actions }) => ({
    loginForm: {
      defaults: {
        email: '',
        password: '',
      } as LoginLogicForm,
      options: {
        showErrorsOnTouch: true,
        canSubmitWithErrors: true,
      },
      errors: (frame: Partial<LoginLogicForm>) => ({
        email: !frame.email ? 'Please enter an e-mail address' : null,
        password: !frame.password ? 'Please enter a password' : null,
      }),
      submit: async (frame) => {
        try {
          const { email, password } = frame
          const formData = new URLSearchParams()
          formData.append('grant_type', 'password')
          formData.append('username', email)
          formData.append('password', password)
          formData.append('scope', 'password')
          const response = await fetch(`/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: formData.toString(),
          })
          if (response.ok) {
            const json = await response.json()
            localStorage.setItem('token', json.access_token)
            window.location.href = '/'
          } else {
            let error
            try {
              const json = await response.json()
              error = json.error
            } catch (e) {
              error = response.statusText
            }
            actions.setLoginFormManualErrors({ password: error })
          }
        } catch (error) {
          console.error(error)
        }
      },
    },
  })),
])
