import { FrameType } from '../types'

const DAY_IN_MS = 24 * 60 * 60 * 1000
const DAYS_IN_YEAR = 365

export type CertificateSeverity = 'ok' | 'expiring' | 'expired'

export interface CertificateValidityInfo {
  severity: CertificateSeverity
  exactDateTime: string
  humanText: string
}

function parseCertificateDate(value?: string): Date | null {
  if (!value) {
    return null
  }

  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function pluralize(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? '' : 's'}`
}

function getDurationText(targetDate: Date): string {
  const now = new Date()
  const differenceMs = targetDate.getTime() - now.getTime()
  const absoluteDays = Math.ceil(Math.abs(differenceMs) / DAY_IN_MS)

  if (differenceMs <= 0) {
    if (absoluteDays <= 1) {
      return 'expired today'
    }
    return `expired ${pluralize(absoluteDays, 'day')} ago`
  }

  if (absoluteDays >= DAYS_IN_YEAR) {
    const years = Math.floor(absoluteDays / DAYS_IN_YEAR)
    return `expires in ${pluralize(years, 'year')}`
  }

  if (absoluteDays <= 1) {
    return 'expires in less than a day'
  }

  return `expires in ${pluralize(absoluteDays, 'day')}`
}

export function getCertificateValidityInfo(value?: string): CertificateValidityInfo | null {
  if (!value) {
    return null
  }

  const parsedDate = parseCertificateDate(value)
  if (!parsedDate) {
    return {
      severity: 'ok',
      exactDateTime: value,
      humanText: `valid until ${value}`,
    }
  }

  const now = new Date()
  const diffMs = parsedDate.getTime() - now.getTime()
  const diffDays = diffMs / DAY_IN_MS

  const severity: CertificateSeverity = diffMs <= 0 ? 'expired' : diffDays < DAYS_IN_YEAR ? 'expiring' : 'ok'

  return {
    severity,
    exactDateTime: parsedDate.toLocaleString(),
    humanText: getDurationText(parsedDate),
  }
}

export function getFrameCertificateStatus(
  frame: Pick<FrameType, 'https_proxy'>
): CertificateSeverity | null {
  const certDates = [
    frame.https_proxy?.client_ca_cert_not_valid_after,
    frame.https_proxy?.server_cert_not_valid_after,
  ]
  const infos = certDates
    .map((date) => getCertificateValidityInfo(date))
    .filter((info): info is CertificateValidityInfo => !!info)

  if (!infos.length) {
    return null
  }

  if (infos.some((info) => info.severity === 'expired')) {
    return 'expired'
  }

  if (infos.some((info) => info.severity === 'expiring')) {
    return 'expiring'
  }

  return 'ok'
}
