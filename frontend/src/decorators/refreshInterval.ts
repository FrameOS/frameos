export function showAsFps(refreshInterval: number): string {
  return refreshInterval > 1 ? `${refreshInterval} sec` : `${Math.round((1 / refreshInterval) * 10) / 10} fps`
}
