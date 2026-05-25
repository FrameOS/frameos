import { actions, afterMount, kea, path, reducers } from 'kea'
import { forms } from 'kea-forms'
import { loaders } from 'kea-loaders'

import { apiFetch } from '../../utils/apiFetch'
import { showSuccessMessage } from '../../utils/workingMessage'

import type { accountLogicType } from './accountLogicType'

export interface AccountUser {
  email: string
}

export interface AccountPasswordForm {
  current_password: string
  password: string
  password2: string
}

const defaultPasswordForm: AccountPasswordForm = {
  current_password: '',
  password: '',
  password2: '',
}

async function responseErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json()
    if (typeof payload?.detail === 'string') {
      return payload.detail
    }
    if (Array.isArray(payload?.detail)) {
      return payload.detail
        .map((detail: { msg?: string }) => detail?.msg)
        .filter(Boolean)
        .join(' ')
    }
    if (typeof payload?.error === 'string') {
      return payload.error
    }
  } catch {
    // Use fallback below.
  }
  return fallback
}

export const accountLogic = kea<accountLogicType>([
  path(['src', 'scenes', 'settings', 'accountLogic']),
  actions({
    setPasswordChanged: (changed: boolean) => ({ changed }),
    setPasswordEditorOpen: (open: boolean) => ({ open }),
  }),
  reducers({
    passwordEditorOpen: [
      false,
      {
        setPasswordEditorOpen: (_, { open }) => open,
      },
    ],
    passwordChanged: [
      false,
      {
        setPasswordChanged: (_, { changed }) => changed,
        setPasswordEditorOpen: () => false,
        setAccountPasswordValue: () => false,
        setAccountPasswordValues: () => false,
        resetAccountPassword: () => false,
      },
    ],
  }),
  loaders(() => ({
    account: [
      null as AccountUser | null,
      {
        loadAccount: async () => {
          const response = await apiFetch('/api/user')
          if (!response.ok) {
            throw new Error(await responseErrorMessage(response, 'Failed to load account'))
          }
          return (await response.json()) as AccountUser
        },
      },
    ],
  })),
  forms(({ actions }) => ({
    accountPassword: {
      defaults: defaultPasswordForm,
      options: {
        showErrorsOnTouch: true,
      },
      errors: (form: Partial<AccountPasswordForm>) => ({
        current_password: !form.current_password ? 'Enter your current password' : null,
        password: !form.password
          ? 'Enter a new password'
          : form.password.length < 8
          ? 'Password must be at least 8 characters'
          : null,
        password2: form.password !== form.password2 ? 'Passwords do not match' : null,
      }),
      submit: async (form) => {
        actions.setPasswordChanged(false)
        const response = await apiFetch('/api/user/password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(form),
        })

        if (!response.ok) {
          const message = await responseErrorMessage(response, 'Failed to update password')
          actions.setAccountPasswordManualErrors({ current_password: message })
          return
        }

        actions.resetAccountPassword(defaultPasswordForm)
        actions.setPasswordChanged(true)
        actions.setPasswordEditorOpen(false)
        showSuccessMessage('Password changed')
      },
    },
  })),
  afterMount(({ actions }) => {
    actions.loadAccount()
  }),
])
