export function inHassioIngress() {
  return typeof window !== 'undefined' && (window as any).FRAMEOS_APP_CONFIG?.HASSIO_MODE === 'ingress'
}
