export function getBasePath(): string {
  return typeof window !== 'undefined' ? (window as any).FRAMEOS_APP_CONFIG?.base_path || '' : ''
}
