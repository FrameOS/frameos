export function getResponseDetail(payload: unknown): string | null {
  if (payload && typeof payload === 'object' && 'detail' in payload && typeof payload.detail === 'string') {
    return payload.detail
  }
  return null
}

export function isFrameConnectionError(detail: string | null | undefined): boolean {
  if (!detail) {
    return false
  }

  const normalizedDetail = detail.toLowerCase()
  return (
    normalizedDetail.includes('unable to connect to') ||
    normalizedDetail.includes('unable to reach frame') ||
    normalizedDetail.includes('agent disconnected') ||
    normalizedDetail.includes('connection refused') ||
    normalizedDetail.includes('no route to host') ||
    normalizedDetail.includes('name or service not known') ||
    normalizedDetail.includes('temporary failure in name resolution') ||
    normalizedDetail.includes('timeout to http') ||
    normalizedDetail.includes('timed out')
  )
}

export function getDeployPlanErrorMessage(payload: unknown): string {
  const detail = getResponseDetail(payload)
  return isFrameConnectionError(detail) ? 'Failed to conennect to frame' : detail || 'Failed to load deploy plans'
}
