/**
 * True inside the Home Assistant add-on in either of its run modes
 * (`ingress` or `public`). `inHassioIngress` only answers for ingress, which
 * is the right question for URL handling but not for "can this install run
 * Docker" - the add-on container has no socket in either mode.
 */
export function inHassioAddon(): boolean {
  return typeof window !== 'undefined' && !!(window as any).FRAMEOS_APP_CONFIG?.HASSIO_RUN_MODE
}
