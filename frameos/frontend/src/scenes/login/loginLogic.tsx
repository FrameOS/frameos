import { actions, kea, listeners, path, reducers } from 'kea'

export const loginLogic = kea([
  path(['frameos', 'frontend', 'loginLogic']),
  actions({
    setUsername: (username: string) => ({ username }),
    setPassword: (password: string) => ({ password }),
    submitLogin: true,
    setLoading: (loading: boolean) => ({ loading }),
    setError: (error: string | null) => ({ error }),
  }),
  reducers({
    username: ['', { setUsername: (_, { username }) => username }],
    password: ['', { setPassword: (_, { password }) => password }],
    loading: [false, { setLoading: (_, { loading }) => loading }],
    error: [null as string | null, { setError: (_, { error }) => error }],
  }),
  listeners(({ actions, values }) => ({
    submitLogin: async () => {
      actions.setLoading(true)
      actions.setError(null)
      try {
        const response = await fetch('/api/admin/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: values.username, password: values.password }),
        })
        if (!response.ok) {
          actions.setError('Invalid credentials')
          return
        }
        window.location.href = '/admin'
      } catch {
        actions.setError('Login failed')
      } finally {
        actions.setLoading(false)
      }
    },
  })),
])
