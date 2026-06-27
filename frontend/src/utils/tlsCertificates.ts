import * as forge from 'node-forge'

export interface GeneratedTlsMaterial {
  certs: {
    server: string
    server_key: string
    client_ca: string
  }
  server_cert_not_valid_after: string
  client_ca_cert_not_valid_after: string
}

function certificateName(commonName: string): Array<{ name: string; value: string }> {
  return [{ name: 'commonName', value: commonName }]
}

function isIpv4Address(value: string): boolean {
  const parts = value.split('.')
  return parts.length === 4 && parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255)
}

function isIpAddress(value: string): boolean {
  return isIpv4Address(value) || (value.includes(':') && /^[0-9a-fA-F:.]+$/.test(value))
}

function subjectAltNames(frameHost: string): Array<Record<string, unknown>> {
  const altNames: Array<{ type: 2; value: string } | { type: 7; ip: string }> = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
  ]
  if (frameHost) {
    altNames.push(isIpAddress(frameHost) ? { type: 7, ip: frameHost } : { type: 2, value: frameHost })
  }
  return [{ name: 'subjectAltName', altNames }]
}

function serialNumber(): string {
  // X.509 serial numbers must be positive. Prefix with 01 to keep the high bit clear.
  return `01${forge.util.bytesToHex(forge.random.getBytesSync(15))}`
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000)
}

function isoDate(date: Date): string {
  return date.toISOString().replace('Z', '+00:00')
}

export function generateFrameTlsMaterial(frameHost: string): GeneratedTlsMaterial {
  const normalizedHost = frameHost.trim()
  const now = new Date()
  const notBefore = new Date(now.getTime() - 5 * 60 * 1000)

  const caKeys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 })
  const caCert = forge.pki.createCertificate()
  caCert.publicKey = caKeys.publicKey
  caCert.serialNumber = serialNumber()
  caCert.validity.notBefore = notBefore
  caCert.validity.notAfter = addDays(now, 3650)
  const caSubject = certificateName(`FrameOS Frame CA (${normalizedHost || 'frame'})`)
  caCert.setSubject(caSubject)
  caCert.setIssuer(caSubject)
  caCert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyCertSign: true, cRLSign: true, critical: true },
  ])
  caCert.sign(caKeys.privateKey, forge.md.sha256.create())

  const serverKeys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 })
  const serverCert = forge.pki.createCertificate()
  serverCert.publicKey = serverKeys.publicKey
  serverCert.serialNumber = serialNumber()
  serverCert.validity.notBefore = notBefore
  serverCert.validity.notAfter = addDays(now, 825)
  serverCert.setSubject(certificateName(normalizedHost || 'frame.local'))
  serverCert.setIssuer(caCert.subject.attributes)
  serverCert.setExtensions([
    ...subjectAltNames(normalizedHost),
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
  ])
  serverCert.sign(caKeys.privateKey, forge.md.sha256.create())

  return {
    certs: {
      server: forge.pki.certificateToPem(serverCert),
      server_key: forge.pki.privateKeyToPem(serverKeys.privateKey),
      client_ca: forge.pki.certificateToPem(caCert),
    },
    server_cert_not_valid_after: isoDate(serverCert.validity.notAfter),
    client_ca_cert_not_valid_after: isoDate(caCert.validity.notAfter),
  }
}
