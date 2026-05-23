import { actions, afterMount, kea, listeners, path, reducers } from 'kea'

import type { authThemeLogicType } from './authThemeLogicType'

export type AuthTheme = 'light' | 'dark'

function getInitialAuthTheme(): AuthTheme {
  if (typeof window === 'undefined') {
    return 'light'
  }
  const storedTheme = window.localStorage.getItem('frameos.workspaceTheme')
  if (storedTheme === 'light' || storedTheme === 'dark') {
    return storedTheme
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyAuthTheme(theme: AuthTheme): void {
  if (typeof document === 'undefined') {
    return
  }
  document.documentElement.dataset.frameosTheme = theme
  document.documentElement.style.colorScheme = theme
}

export const authThemeLogic = kea<authThemeLogicType>([
  path(['src', 'scenes', 'auth', 'authThemeLogic']),
  actions({
    toggleTheme: true,
  }),
  reducers({
    theme: [
      getInitialAuthTheme(),
      {
        toggleTheme: (theme) => (theme === 'dark' ? 'light' : 'dark'),
      },
    ],
  }),
  listeners(({ values }) => ({
    toggleTheme: () => {
      window.localStorage.setItem('frameos.workspaceTheme', values.theme)
      applyAuthTheme(values.theme)
    },
  })),
  afterMount(({ values }) => {
    applyAuthTheme(values.theme)
  }),
])
