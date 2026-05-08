export const FRAME_ADMIN_LOGIN_USER_PARAM = '__login_user'
export const FRAME_ADMIN_LOGIN_PASS_PARAM = '__login_pass'

type LocationLike = Pick<Location, 'pathname' | 'search' | 'hash'>

export interface FrameAdminLoginParams {
  username: string | null
  password: string | null
  hasParams: boolean
}

function parseParams(value: string): URLSearchParams {
  if (!value) {
    return new URLSearchParams()
  }

  return new URLSearchParams(value.startsWith('?') || value.startsWith('#') ? value.slice(1) : value)
}

export function getFrameAdminLoginParams(location: LocationLike = window.location): FrameAdminLoginParams {
  const searchParams = parseParams(location.search)
  const hashParams = parseParams(location.hash)
  const username = searchParams.get(FRAME_ADMIN_LOGIN_USER_PARAM) ?? hashParams.get(FRAME_ADMIN_LOGIN_USER_PARAM)
  const password = searchParams.get(FRAME_ADMIN_LOGIN_PASS_PARAM) ?? hashParams.get(FRAME_ADMIN_LOGIN_PASS_PARAM)

  return {
    username,
    password,
    hasParams: username !== null || password !== null,
  }
}

export function stripFrameAdminLoginParams(location: LocationLike = window.location): string {
  const searchParams = parseParams(location.search)
  const hashParams = parseParams(location.hash)

  searchParams.delete(FRAME_ADMIN_LOGIN_USER_PARAM)
  searchParams.delete(FRAME_ADMIN_LOGIN_PASS_PARAM)
  hashParams.delete(FRAME_ADMIN_LOGIN_USER_PARAM)
  hashParams.delete(FRAME_ADMIN_LOGIN_PASS_PARAM)

  const nextSearch = searchParams.toString()
  const nextHash = hashParams.toString()

  return `${location.pathname}${nextSearch ? `?${nextSearch}` : ''}${nextHash ? `#${nextHash}` : ''}`
}
