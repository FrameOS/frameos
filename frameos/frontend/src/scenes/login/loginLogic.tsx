import { actions, afterMount, kea, listeners, path, reducers } from 'kea'
import {
  getFrameAdminLoginParams,
  stripFrameAdminLoginParams,
} from '../../utils/frameAdminLoginParams'

type FrameosTheme = 'light' | 'dark'

function getInitialTheme(): FrameosTheme {
  if (typeof window === 'undefined') {
    return 'dark'
  }
  const storedTheme = window.localStorage.getItem('frameos.workspaceTheme')
  if (storedTheme === 'light' || storedTheme === 'dark') {
    return storedTheme
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyLoginTheme(theme: FrameosTheme): void {
  if (typeof document === 'undefined') {
    return
  }
  document.documentElement.dataset.frameosTheme = theme
  document.documentElement.style.colorScheme = theme
}

export const loginLogic = kea([
  path(['frameos', 'frontend', 'loginLogic']),
  actions({
    setUsername: (username: string) => ({ username }),
    setPassword: (password: string) => ({ password }),
    submitLogin: (credentials?: { username?: string; password?: string }) => ({ credentials }),
    setLoading: (loading: boolean) => ({ loading }),
    setError: (error: string | null) => ({ error }),
    setCloudLoginAvailable: (available: boolean) => ({ available }),
    startCloudLogin: true,
    bootstrapLoginPage: true,
    toggleTheme: true,
  }),
  reducers({
    username: ['', { setUsername: (_, { username }) => username }],
    password: ['', { setPassword: (_, { password }) => password }],
    loading: [false, { setLoading: (_, { loading }) => loading }],
    error: [null as string | null, { setError: (_, { error }) => error, startCloudLogin: () => null }],
    cloudLoginAvailable: [false, { setCloudLoginAvailable: (_, { available }) => available }],
    theme: [getInitialTheme(), { toggleTheme: (theme) => (theme === 'dark' ? 'light' : 'dark') }],
  }),
  listeners(({ actions, values }) => ({
    toggleTheme: () => {
      window.localStorage.setItem('frameos.workspaceTheme', values.theme)
      applyLoginTheme(values.theme)
    },
    bootstrapLoginPage: async () => {
      if (typeof window === 'undefined') {
        return
      }

      const { username, password, hasParams } = getFrameAdminLoginParams()

      if (hasParams) {
        actions.setUsername(username || '')
        actions.setPassword(password || '')
        window.history.replaceState(
          window.history.state,
          '',
          stripFrameAdminLoginParams()
        )
      }

      try {
        const response = await fetch('/api/admin/session')
        const payload = response.ok ? await response.json() : { authenticated: false }
        if (Boolean(payload?.authenticated)) {
          window.location.replace('/admin')
          return
        }
      } catch {
        // Ignore session check failures here and allow manual login.
      }

      if (username !== null && password !== null) {
        actions.submitLogin({ username, password })
      }

      // Offer "Continue with FrameOS Cloud" when this frame's cloud link has
      // the auth:login permission. The callback redirects back with
      // ?cloudError=… on failure.
      try {
        const optionsResponse = await fetch('/api/cloud/login/options')
        if (optionsResponse.ok) {
          const options = await optionsResponse.json()
          actions.setCloudLoginAvailable(Boolean(options?.available))
        }
        const cloudError = new URLSearchParams(window.location.search).get('cloudError')
        if (cloudError) {
          actions.setError(`FrameOS Cloud login failed: ${cloudError}`)
        }
      } catch {
        // No cloud link; password login only.
      }
    },
    startCloudLogin: async () => {
      try {
        const response = await fetch('/api/cloud/login/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })
        const payload = await response.json().catch(() => ({}))
        if (!response.ok || !payload.authorization_url) {
          actions.setError(payload.detail || 'Could not start the FrameOS Cloud login')
          return
        }
        window.location.href = payload.authorization_url
      } catch {
        actions.setError('Could not start the FrameOS Cloud login')
      }
    },
    submitLogin: async ({ credentials }) => {
      if (values.loading) {
        return
      }

      actions.setLoading(true)
      actions.setError(null)
      try {
        const username = credentials?.username ?? values.username
        const password = credentials?.password ?? values.password
        const response = await fetch('/api/admin/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        })
        if (!response.ok) {
          actions.setError('Invalid credentials')
          return
        }
        window.location.replace('/admin')
      } catch {
        actions.setError('Login failed')
      } finally {
        actions.setLoading(false)
      }
    },
  })),
  afterMount(({ actions, values }) => {
    applyLoginTheme(values.theme)
    actions.bootstrapLoginPage()
  }),
])
