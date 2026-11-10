import { describe, expect, it } from 'vitest'

import type { FrameScene } from '../../../../../../frontend/src/types'
import {
  frameSceneStorage,
  frameStorageLabel,
  sceneJsonBytes,
  sceneSizeLabel,
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
})
