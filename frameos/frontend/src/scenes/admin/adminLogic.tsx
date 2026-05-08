import { actions, afterMount, kea, listeners, path, reducers } from 'kea'
import { getFrameAdminLoginParams, stripFrameAdminLoginParams } from '../../utils/frameAdminLoginParams'

export const adminLogic = kea([
  path(['frameos', 'frontend', 'scenes', 'admin', 'adminLogic']),
  actions({
    checkSession: true,
    setSessionState: (isChecking: boolean, isAuthenticated: boolean) => ({ isChecking, isAuthenticated }),
    logout: true,
  }),
  reducers({
    isChecking: [true, { setSessionState: (_, { isChecking }) => isChecking }],
    isAuthenticated: [false, { setSessionState: (_, { isAuthenticated }) => isAuthenticated }],
  }),
  listeners(({ actions }) => ({
    checkSession: async () => {
      if (typeof window !== 'undefined' && getFrameAdminLoginParams().hasParams) {
        window.history.replaceState(window.history.state, '', stripFrameAdminLoginParams())
      }

      try {
        const response = await fetch('/api/admin/session')
        const payload = response.ok ? await response.json() : { authenticated: false }
        actions.setSessionState(false, Boolean(payload?.authenticated))
      } catch {
        actions.setSessionState(false, false)
      }
    },
    logout: async () => {
      await fetch('/api/admin/logout', { method: 'POST' })
      window.location.href = '/login'
    },
  })),
  afterMount(({ actions }) => {
    actions.checkSession()
  }),
])
