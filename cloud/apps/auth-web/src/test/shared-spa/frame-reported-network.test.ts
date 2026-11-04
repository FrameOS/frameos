import { describe, expect, it } from 'vitest'
import { frameReportedNetwork } from '../../../../../../frontend/src/utils/frameReportedNetwork'

describe('frameReportedNetwork', () => {
  it('reads the backend copy and the cloud one', () => {
    expect(frameReportedNetwork({ embedded: { reported: { wifiSsid: 'Cafe', ip: '10.0.0.9' } } })).toBe(
      'The frame says it is on \u201cCafe\u201d at 10.0.0.9.'
    )
    expect(frameReportedNetwork({ hardware: { wifiSsid: 'Cafe' } } as never)).toBe(
      'The frame says it is on \u201cCafe\u201d.'
    )
  })

  it('says nothing without a network', () => {
    expect(frameReportedNetwork({})).toBeNull()
    expect(frameReportedNetwork({ hardware: { wifiSsid: '' } } as never)).toBeNull()
  })
})
