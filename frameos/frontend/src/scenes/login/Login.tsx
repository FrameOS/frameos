import { useActions, useValues } from 'kea'

import { Button } from '../../../../../frontend/src/components/Button'
import { TextInput } from '../../../../../frontend/src/components/TextInput'
import { loginLogic } from './loginLogic'

export default function Login() {
  const { username, password, loading, error } = useValues(loginLogic)
  const { setUsername, setPassword, submitLogin } = useActions(loginLogic)

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-900 px-4">
      <form
        className="w-full max-w-sm space-y-4 rounded-xl border border-slate-700 bg-slate-800 p-6"
        onSubmit={(e) => {
          e.preventDefault()
          submitLogin()
        }}
      >
        <h1 className="text-xl font-semibold text-white">Admin login</h1>
        <TextInput
          placeholder="Username"
          value={username}
          onChange={(value) => setUsername(value)}
          autoComplete="username"
        />
        <TextInput
          placeholder="Password"
          type="password"
          value={password}
          onChange={(value) => setPassword(value)}
          autoComplete="current-password"
        />
        {error ? <div className="text-sm text-red-300">{error}</div> : null}
        <Button type="submit" color="primary" disabled={loading} full>
          {loading ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </div>
  )
}
