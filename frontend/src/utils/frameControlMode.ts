export function isFrameControlMode(): boolean {
  return typeof window !== 'undefined' && (window as any).FRAMEOS_APP_CONFIG?.frameMode === 'frame'
}

export function getFrameControlFrameId(): number {
  if (typeof window === 'undefined') {
    return 1
  }
  const raw = (window as any).FRAMEOS_APP_CONFIG?.frameId
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw
  }
  if (typeof raw === 'string') {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return 1
}
