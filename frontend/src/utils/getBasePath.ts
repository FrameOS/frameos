export function getBasePath(): string {
  const basePath = typeof window !== 'undefined' ? (window as any).FRAMEOS_APP_CONFIG?.base_path || '' : ''
  return basePath.endsWith('/') ? basePath.slice(0, -1) : basePath
}
