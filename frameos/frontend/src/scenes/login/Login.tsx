import { useActions, useValues } from 'kea'
import { MoonIcon, SunIcon } from '@heroicons/react/24/outline'
import clsx from 'clsx'

import { TextInput } from '../../../../../frontend/src/components/TextInput'
import { loginLogic } from './loginLogic'

export default function Login() {
  const { username, password, loading, error, theme } = useValues(loginLogic)
  const { setUsername, setPassword, submitLogin, toggleTheme } = useActions(loginLogic)
  const darkMode = theme === 'dark'

  return (
    <div
      className={clsx('frame-local-login flex min-h-screen items-center justify-center px-4', `frameos-theme-${theme}`)}
    >
      <button
        type="button"
        title={darkMode ? 'Use light mode' : 'Use dark mode'}
        onClick={toggleTheme}
        className="frame-local-login-toggle fixed right-5 top-5 inline-flex h-11 items-center gap-2 rounded-xl px-3 text-sm font-semibold shadow-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
      >
        {darkMode ? <SunIcon className="h-5 w-5" /> : <MoonIcon className="h-5 w-5" />}
        <span>{darkMode ? 'Light' : 'Dark'}</span>
      </button>
      <form
        className="frame-local-login-card w-full max-w-sm space-y-4 rounded-2xl border p-6 shadow-2xl backdrop-blur-xl"
        onSubmit={(e) => {
          e.preventDefault()
          submitLogin()
        }}
      >
        <h1 className="frame-local-login-title text-xl font-semibold">Admin login</h1>
        <label className="frame-local-login-field block space-y-2">
          <span className="text-xs font-semibold uppercase tracking-wide">Username</span>
          <TextInput
            placeholder="Username"
            value={username}
            onChange={(value) => setUsername(value)}
            autoComplete="username"
            className="frame-local-login-input"
          />
        </label>
        <label className="frame-local-login-field block space-y-2">
          <span className="text-xs font-semibold uppercase tracking-wide">Password</span>
          <TextInput
            placeholder="Password"
            type="password"
            value={password}
            onChange={(value) => setPassword(value)}
            autoComplete="current-password"
            className="frame-local-login-input"
          />
        </label>
        {error ? <div className="frame-local-login-error text-sm font-semibold">{error}</div> : null}
        <button
          type="submit"
          disabled={loading}
          className="frame-local-login-submit h-12 w-full rounded-xl px-5 text-sm font-semibold shadow-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
