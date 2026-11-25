import { describe, expect, it } from 'vitest'

import type { FrameScene } from '../../../../../../frontend/src/types'
import {
  frameSceneStorage,
  frameStorageLabel,
  frameStorageSummary,
  frameStorageTone,
  sceneJsonBytes,
  sceneSizeLabel,
  storageUsedPercent,
} from '../../../../../../frontend/src/utils/frameSceneStorage'

describe('what an ESP32 frame holds', () => {
  const report = { stateTotalBytes: 1_000_000, stateUsedBytes: 400_000, scenesBytes: 300_000, sceneCount: 18 }

  it('reads the cloud hardware report and the backend embedded one', () => {
    expect(frameSceneStorage({ hardware: { storage: report } })).toEqual({ ...report, sceneBytes: {} })
    expect(frameSceneStorage({ embedded: { storage: report } })).toEqual({ ...report, sceneBytes: {} })
  })

  it('is nothing for a frame that does not report it', () => {
    expect(frameSceneStorage({})).toBeNull()
    expect(frameSceneStorage({ hardware: { storage: { flashBytes: 8_000_000 } } })).toBeNull()
    expect(frameStorageLabel({})).toBeNull()
  })

  it('says what is free first, in plain words', () => {
    expect(frameStorageLabel({ hardware: { storage: report } })).toBe(
      '586 KB free of 977 KB on the frame, scenes 293 KB'
    )
    // Never a negative free figure, whatever a report says.
    expect(frameStorageLabel({ hardware: { storage: { ...report, stateUsedBytes: 2_000_000 } } })).toBe(
      '0 B free of 977 KB on the frame, scenes 293 KB'
    )
  })

  it('takes each scene\'s size from the frame, numbers only', () => {
    const storage = { ...report, sceneBytes: { clock: 4769, map: 89_824, bad: 'big', neg: -1 } }
    expect(frameSceneStorage({ embedded: { storage } } as never)?.sceneBytes).toEqual({ clock: 4769, map: 89_824 })
  })

  it('sizes a scene by what the frame stores of it, else its JSON, marked as an estimate', () => {
    const scene = { id: 'clock', name: 'x' } as unknown as FrameScene
    const frame = { hardware: { storage: { ...report, sceneBytes: { clock: 4769 } } } }
    expect(sceneSizeLabel(scene, frame as never)).toBe('4.7 KB')
    const other = { id: 'é', name: 'x' } as unknown as FrameScene
    expect(sceneJsonBytes(other)).toBe(new TextEncoder().encode(JSON.stringify(other)).length)
    expect(sceneJsonBytes(other)).toBeGreaterThan(JSON.stringify(other).length)
    expect(sceneSizeLabel(other, frame as never)).toMatch(/^~\d+ B$/)
    expect(sceneSizeLabel(other)).toMatch(/^~/)
  })

  it('says how full the disk is in whole percent, never 0 with something on it or 100 with room left', () => {
    expect(storageUsedPercent(7_045_272, 21_798_465)).toBe(32)
    expect(storageUsedPercent(0, 1000)).toBe(0)
    expect(storageUsedPercent(1, 1000)).toBe(1)
    expect(storageUsedPercent(999, 1000)).toBe(99)
    expect(storageUsedPercent(1000, 1000)).toBe(100)
    expect(storageUsedPercent(5000, 1000)).toBe(100)
    expect(storageUsedPercent(10, 0)).toBe(0)
  })

  it('colors the disk by how full it is', () => {
    expect(frameStorageTone(0)).toBe('ok')
    expect(frameStorageTone(79)).toBe('ok')
    expect(frameStorageTone(80)).toBe('filling')
    expect(frameStorageTone(94)).toBe('filling')
    expect(frameStorageTone(95)).toBe('full')
  })

  it('sums up the disk for the popup: used, free, the scenes, the rest, each scene largest first by name', () => {
    // Frame 76 of a dev backend, a reTerminal Sticky with 11 scenes, none of them imported.
    const storage = {
      stateTotalBytes: 21_798_465,
      stateUsedBytes: 7_045_272,
      scenesBytes: 397_995,
      sceneCount: 11,
      sceneBytes: { clock: 6591, 'scene-store': 64_389, 'asset-browser': 49_686, countdown: 15_717 },
    }
    const summary = frameStorageSummary({
      embedded: { storage },
      scenes: [
        { id: 'clock', name: 'Clock' },
        { id: 'asset-browser', name: 'Files' },
        { id: 'countdown', name: '  ' },
      ],
    })
    expect(summary).toEqual({
      totalBytes: 21_798_465,
      usedBytes: 7_045_272,
      freeBytes: 14_753_193,
      usedPercent: 32,
      scenesBytes: 397_995,
      sceneCount: 11,
      otherBytes: 6_647_277,
      scenes: [
        { id: 'scene-store', name: null, bytes: 64_389 },
        { id: 'asset-browser', name: 'Files', bytes: 49_686 },
        { id: 'countdown', name: null, bytes: 15_717 },
        { id: 'clock', name: 'Clock', bytes: 6591 },
      ],
    })
    expect(frameStorageLabel({ embedded: { storage } })).toBe('14.1 MB free of 20.8 MB on the frame, scenes 389 KB')
  })

  it('never reports more used than there is, nor a negative rest', () => {
    const summary = frameStorageSummary({
      hardware: { storage: { stateTotalBytes: 1000, stateUsedBytes: 1500, scenesBytes: 2000, sceneCount: 1 } },
    })
    expect(summary).toMatchObject({ usedBytes: 1000, freeBytes: 0, usedPercent: 100, otherBytes: 0, scenes: [] })
    expect(frameStorageSummary({})).toBeNull()
  })
})
