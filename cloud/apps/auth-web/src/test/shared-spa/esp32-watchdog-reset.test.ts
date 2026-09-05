import { describe, expect, it } from "vitest"
import { watchdogResetAfterFlash } from "../../../../../../frontend/src/scenes/workspace/esp32WatchdogReset"

function loaderFor(chipName: string | undefined): {
  loader: Parameters<typeof watchdogResetAfterFlash>[0]
  writes: [number, number, number | undefined][]
} {
  const writes: [number, number, number | undefined][] = []
  return {
    writes,
    loader: {
      chip: chipName ? { CHIP_NAME: chipName } : null,
      async writeReg(addr: number, value: number, mask?: number) {
        writes.push([addr, value, mask])
      },
    },
  }
}

describe('watchdogResetAfterFlash', () => {
  it('arms the S3 watchdog after clearing the force-download latch', async () => {
    const { loader, writes } = loaderFor('ESP32-S3')
    expect(await watchdogResetAfterFlash(loader)).toBe(true)
    expect(writes.map(([addr]) => addr)).toEqual([0x6000812c, 0x600080b0, 0x6000809c, 0x60008098, 0x600080b0])
    expect(writes[0]).toEqual([0x6000812c, 0, 0x1])
    expect(writes[1]?.[1]).toBe(0x50d83aa1)
    expect(writes[4]?.[1]).toBe(0)
  })

  it('arms the C3 watchdog at its own register block, with no latch to clear', async () => {
    const { loader, writes } = loaderFor('ESP32-C3')
    expect(await watchdogResetAfterFlash(loader)).toBe(true)
    expect(writes.map(([addr]) => addr)).toEqual([0x600080a8, 0x60008094, 0x60008090, 0x600080a8])
    expect(writes[1]?.[1]).toBe(2000)
    expect(writes[2]?.[1]).toBe((0x80000000 | (5 << 28) | (1 << 8) | 2) >>> 0)
  })

  it('leaves other chips to the DTR/RTS fallback', async () => {
    for (const chip of ['ESP32', 'ESP32-C6', undefined]) {
      const { loader, writes } = loaderFor(chip)
      expect(await watchdogResetAfterFlash(loader)).toBe(false)
      expect(writes).toEqual([])
    }
  })

  it('reports false when arming fails before the point of no return', async () => {
    const { loader } = loaderFor('ESP32-C3')
    loader.writeReg = async () => {
      throw new Error('port gone')
    }
    expect(await watchdogResetAfterFlash(loader)).toBe(false)
  })
})
