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
    expect(frameSceneStorage({ hardware: { storage: report } })).toEqual(report)
    expect(frameSceneStorage({ embedded: { storage: report } })).toEqual(report)
  })

  it('is nothing for a frame that does not report it', () => {
    expect(frameSceneStorage({})).toBeNull()
    expect(frameSceneStorage({ hardware: { storage: { flashBytes: 8_000_000 } } })).toBeNull()
    expect(frameStorageLabel({})).toBeNull()
  })

  it('says it in plain words', () => {
    expect(frameStorageLabel({ hardware: { storage: report } })).toBe(
      '391 KB of 977 KB used on the frame, scenes 293 KB'
    )
  })

  it('sizes a scene by its JSON, counting bytes not characters', () => {
    const scene = { id: 'é', name: 'x' } as unknown as FrameScene
    expect(sceneJsonBytes(scene)).toBe(new TextEncoder().encode(JSON.stringify(scene)).length)
    expect(sceneJsonBytes(scene)).toBeGreaterThan(JSON.stringify(scene).length)
    expect(sceneSizeLabel(scene)).toMatch(/B$/)
  })
})
