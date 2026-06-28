const FRAME_ADMIN_PATH = '/admin'

export function isFrameAdminPath(pathname: string): boolean {
  return pathname === FRAME_ADMIN_PATH || pathname.startsWith(`${FRAME_ADMIN_PATH}/`)
}

export function isInFrameAdminMode(): boolean {
  return (
    typeof window !== 'undefined' &&
    (!!(window as any).FRAMEOS_APP_CONFIG?.frameAdminMode || isFrameAdminPath(window.location.pathname))
  )
}

export function frameAdminPath(): string {
  return FRAME_ADMIN_PATH
}
