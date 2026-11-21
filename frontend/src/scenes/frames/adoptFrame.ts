// What the Adopt frame pane sends to POST /api/frames/adopt (docs/api-triality.md).
// Two ways in: the six-digit code the frame shows on its own screen (Settings →
// the gear → Managed by → Your backend), which works for a Pi and an ESP32
// alike, or a Pi's admin login.

export type AdoptMethod = 'code' | 'login'

export const ADOPT_CODE_DIGITS = 6

export interface AdoptFields {
  method: AdoptMethod
  host: string
  port: string
  code: string
  adminUser: string
  adminPass: string
  serverHost: string
  name: string
}

/** What the code field keeps of what was typed or pasted: digits, six at most. */
export function adoptCodeInput(value: string): string {
  return value.replace(/\D/g, '').slice(0, ADOPT_CODE_DIGITS)
}

/** What the frame page's QR code says (docs/scene-settings.md "Connecting the
 * frame"): its address, with a port unless it is 80, and its code, as
 * "10.0.0.42:8787 123456". Pasted into the address, it fills all three; null
 * for anything else, which is an address as typed. */
export function adoptPaste(value: string): { host: string; port: string; code: string } | null {
  const match = /^\s*([^\s:/[\]]+|\[[0-9a-f:]+\])(?::(\d{1,5}))?\s+(\d{3}[\s-]?\d{3})\s*$/i.exec(value)
  if (!match) {
    return null
  }
  return { host: match[1] ?? '', port: match[2] ?? '', code: adoptCodeInput(match[3] ?? '') }
}

export function adoptCanSubmit(fields: AdoptFields): boolean {
  if (fields.host.trim() === '' || fields.serverHost.trim() === '') {
    return false
  }
  if (fields.method === 'code') {
    return fields.code.length === ADOPT_CODE_DIGITS
  }
  return fields.adminUser.trim() !== '' && fields.adminPass !== ''
}

export function adoptRequestBody(fields: AdoptFields): Record<string, unknown> {
  const port = parseInt(fields.port, 10)
  return {
    frame_host: fields.host.trim(),
    // No port typed: the backend tries 8787 (a Pi) and, with a code, 80 (an ESP32).
    ...(port > 0 ? { frame_port: port } : {}),
    ...(fields.method === 'code'
      ? { code: fields.code }
      : { admin_username: fields.adminUser.trim(), admin_password: fields.adminPass }),
    server_host: fields.serverHost.trim(),
    ...(fields.name.trim() ? { name: fields.name.trim() } : {}),
  }
}
