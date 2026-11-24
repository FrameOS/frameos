const EMBEDDED_USB_UPLOAD_MIN_TIMEOUT_MS = 45000
const EMBEDDED_USB_UPLOAD_BASE_TIMEOUT_MS = 30000
const EMBEDDED_USB_UPLOAD_TIMEOUT_MS_PER_KB = 250

/** How long a payload over the USB console (`upload-scenes`) may take: the
 * console reads it at 115200 baud on a USB-UART bridge. */
export function embeddedUsbUploadTimeoutMs(payloadBytes: number): number {
  return Math.max(
    EMBEDDED_USB_UPLOAD_MIN_TIMEOUT_MS,
    EMBEDDED_USB_UPLOAD_BASE_TIMEOUT_MS + Math.ceil(payloadBytes / 1024) * EMBEDDED_USB_UPLOAD_TIMEOUT_MS_PER_KB
  )
}
