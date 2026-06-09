import { urls } from '../../urls'
import { AuthScreen, AuthLink } from './AuthScreen'

export function SetupUnavailable(): JSX.Element {
  return (
    <AuthScreen
      title="Setup unavailable"
      subtitle="FrameOS could not verify whether this installation is already configured. Check the backend and database migrations, then try again."
      footer={<AuthLink href={urls.frames()}>Try again</AuthLink>}
    >
      <div className="auth-warning rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800">
        Account setup is paused until the server can answer the setup status check.
      </div>
    </AuthScreen>
  )
}

export default SetupUnavailable
