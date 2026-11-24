// `?__login_user=…&__login_pass=…` (in the query or the hash) used to sign
// the admin page in from its link. Nothing makes such a link any more and
// the page no longer reads them: a password in a URL is in the browser's
// history, in every bookmark and in whatever logs the address. What is left
// is the tidying: an old bookmark's password is taken out of the address
// bar and the history entry on arrival, unread.
const FRAME_ADMIN_LOGIN_PARAMS = ['__login_user', '__login_pass']

type LocationLike = Pick<Location, 'pathname' | 'search' | 'hash'>

function parseParams(value: string): URLSearchParams {
  if (!value) {
    return new URLSearchParams()
  }

  return new URLSearchParams(value.startsWith('?') || value.startsWith('#') ? value.slice(1) : value)
}

/** Whether the address carries the old login parameters, in its query or its hash. */
export function hasFrameAdminLoginParams(location: LocationLike = window.location): boolean {
  const searchParams = parseParams(location.search)
  const hashParams = parseParams(location.hash)
  return FRAME_ADMIN_LOGIN_PARAMS.some((name) => searchParams.has(name) || hashParams.has(name))
}

/** The address without them, everything else kept. */
export function stripFrameAdminLoginParams(location: LocationLike = window.location): string {
  const searchParams = parseParams(location.search)
  const hashParams = parseParams(location.hash)

  for (const name of FRAME_ADMIN_LOGIN_PARAMS) {
    searchParams.delete(name)
    hashParams.delete(name)
  }

  const nextSearch = searchParams.toString()
  const nextHash = hashParams.toString()

  return `${location.pathname}${nextSearch ? `?${nextSearch}` : ''}${nextHash ? `#${nextHash}` : ''}`
}

/** Take the old login parameters out of the address bar and this history entry. */
export function forgetFrameAdminLoginParams(): void {
  if (typeof window !== 'undefined' && hasFrameAdminLoginParams()) {
    window.history.replaceState(window.history.state, '', stripFrameAdminLoginParams())
  }
}
