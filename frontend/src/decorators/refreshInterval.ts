export function showAsFps(interval: number): string {
  return interval > 86399
    ? `${Math.round((interval / 86400) * 10) / 10} day${interval > 90719 ? 's' : ''}` // when 1.1 days appears
    : interval > 3599
    ? `${Math.round((interval / 3600) * 10) / 10} hour${interval > 3779 ? 's' : ''}` // when 1.1 hours appears
    : interval > 59
    ? `${Math.round((interval / 60) * 10) / 10} min`
    : interval >= 1
    ? `${interval} sec`
    : `${Math.round((1 / interval) * 10) / 10} fps`
}
