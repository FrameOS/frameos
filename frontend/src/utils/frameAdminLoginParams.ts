export const FRAME_ADMIN_LOGIN_USER_PARAM = '__login_user'
export const FRAME_ADMIN_LOGIN_PASS_PARAM = '__login_pass'

export interface FrameAdminLoginParams {
  username: string | null
  password: string | null
  hasParams: boolean
}

export function withFrameAdminLoginParams(url: string, username: string, password: string): string {
  const nextUrl = new URL(url)
  const hashParams = new URLSearchParams(nextUrl.hash.startsWith('#') ? nextUrl.hash.slice(1) : nextUrl.hash)
  hashParams.set(FRAME_ADMIN_LOGIN_USER_PARAM, username)
  hashParams.set(FRAME_ADMIN_LOGIN_PASS_PARAM, password)
  const nextHash = hashParams.toString()
  nextUrl.hash = nextHash ? `#${nextHash}` : ''
  return nextUrl.toString()
}

export function getFrameAdminLoginParams(hash: string): FrameAdminLoginParams {
  const hashParams = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
  const username = hashParams.get(FRAME_ADMIN_LOGIN_USER_PARAM)
  const password = hashParams.get(FRAME_ADMIN_LOGIN_PASS_PARAM)
  return {
    username,
    password,
    hasParams: username !== null || password !== null,
  }
}

export function stripFrameAdminLoginParams(hash: string): string {
  const hashParams = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
  hashParams.delete(FRAME_ADMIN_LOGIN_USER_PARAM)
  hashParams.delete(FRAME_ADMIN_LOGIN_PASS_PARAM)
  const nextHash = hashParams.toString()
  return nextHash ? `#${nextHash}` : ''
}
