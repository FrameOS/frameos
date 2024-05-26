export function showAsFps(refreshInterval: number): string {
  return refreshInterval > 3599
    ? `${Math.round((refreshInterval / 3600) * 10) / 10} hour${refreshInterval > 3779 ? 's' : ''}`
    : refreshInterval > 59
    ? `${Math.round((refreshInterval / 60) * 10) / 10} min`
    : refreshInterval >= 1
    ? `${refreshInterval} sec`
    : `${Math.round((1 / refreshInterval) * 10) / 10} fps`
}
