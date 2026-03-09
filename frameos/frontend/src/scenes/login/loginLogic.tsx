import { actions, afterMount, kea, listeners, path, reducers } from 'kea'
import {
  getFrameAdminLoginParams,
  stripFrameAdminLoginParams,
} from '../../../../../frontend/src/utils/frameAdminLoginParams'

export const loginLogic = kea([
  path(['frameos', 'frontend', 'loginLogic']),
  actions({
    setUsername: (username: string) => ({ username }),
    setPassword: (password: string) => ({ password }),
    submitLogin: (credentials?: { username?: string; password?: string }) => ({ credentials }),
    setLoading: (loading: boolean) => ({ loading }),
    setError: (error: string | null) => ({ error }),
    bootstrapLoginPage: true,
  }),
  reducers({
    username: ['', { setUsername: (_, { username }) => username }],
    password: ['', { setPassword: (_, { password }) => password }],
    loading: [false, { setLoading: (_, { loading }) => loading }],
    error: [null as string | null, { setError: (_, { error }) => error }],
  }),
  listeners(({ actions, values }) => ({
    bootstrapLoginPage: async () => {
      if (typeof window === 'undefined') {
        return
      }

      const { username, password, hasParams } = getFrameAdminLoginParams(window.location.hash)

      if (hasParams) {
        actions.setUsername(username || '')
        actions.setPassword(password || '')
        const nextHash = stripFrameAdminLoginParams(window.location.hash)
        window.history.replaceState(
          window.history.state,
          '',
          `${window.location.pathname}${window.location.search}${nextHash}`
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
  afterMount(({ actions }) => {
    actions.bootstrapLoginPage()
  }),
])
