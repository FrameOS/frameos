import type { FrameType } from '../types'

/**
 * The Wi-Fi network and address an ESP32 says it is on: it can join another
 * on its own screen, and neither control plane can send it one. The backend
 * keeps it under `embedded.reported`, the cloud in the hello's `hardware`.
 */
export function frameReportedNetwork(frame: Pick<FrameType, 'embedded' | 'hardware'>): string | null {
  const report = frame.embedded?.reported ?? frame.hardware
  if (!report?.wifiSsid) {
    return null
  }
  return report.ip
    ? `The frame says it is on \u201c${report.wifiSsid}\u201d at ${report.ip}.`
    : `The frame says it is on \u201c${report.wifiSsid}\u201d.`
}
