declare module 'qrcode' {
  export type QRCodeErrorCorrectionLevel = 'L' | 'M' | 'Q' | 'H'

  export interface QRCodeToDataURLOptions {
    errorCorrectionLevel?: QRCodeErrorCorrectionLevel
    margin?: number
    width?: number
  }

  const QRCode: {
    toDataURL(text: string, options?: QRCodeToDataURLOptions): Promise<string>
  }

  export default QRCode
}
