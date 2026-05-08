type LocationLike = Pick<Location, 'search' | 'hash'>

const parseParams = (value: string): URLSearchParams => {
  if (!value) {
    return new URLSearchParams()
  }
  return new URLSearchParams(value.startsWith('?') || value.startsWith('#') ? value.slice(1) : value)
}

export const getAccessKeyFromLocation = (location: LocationLike = window.location): string | null => {
  const hashParams = parseParams(location.hash)
  const searchParams = parseParams(location.search)
  return hashParams.get('k') || searchParams.get('k')
}

export const getRequestedScalingMode = (location: LocationLike = window.location): string | null => {
  const searchParams = parseParams(location.search)
  return searchParams.get('s')
}

export const getInitialScalingMode = (fallback: string = 'contain'): string => {
  if (typeof document === 'undefined') {
    return fallback
  }
  const scalingMode = document.body?.dataset?.scalingMode
  return scalingMode && scalingMode.trim() !== '' ? scalingMode : fallback
}

export const appendAccessKey = (url: string, accessKey: string | null): string => {
  if (!accessKey) {
    return url
  }
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}k=${encodeURIComponent(accessKey)}`
}
