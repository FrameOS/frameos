// A frame with an accelerometer binds its motion like a key (docs/accelerometer.md;
// docs/events.md "Event map"): a flick, a tilt, a shake, an orientation it comes
// to rest in. The frame's "Button actions" and a scene's "Map buttons" write the
// same rules (frontend/src/utils/frameEventMap.ts); docs/button-map-fixtures.json
// pins how one reads back, this file what is offered and the scene's half.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { EventMapRule } from '../../../../../../frontend/src/types'
import {
  ACCELEROMETER_HARDWARE_PRESETS,
  frameHasAccelerometer,
} from '../../../../../../frontend/src/utils/accelerometer'
import {
  bindingConflicts,
  bindingOfRule,
  bindingRule,
  frameActionKindsFor,
  frameGestureTitle,
  frameGestureValue,
  frameSupportsMotionGestures,
  gestureCanVoiceChat,
  motionDirections,
  motionGestures,
  motionGesturesMinVersion,
  motionPositions,
  parseFrameGestureValue,
  sceneMotionBindings,
} from '../../../../../../frontend/src/utils/frameEventMap'
import { contractEventSpecs } from '../../../../../../frontend/src/utils/eventsContract.gen'

const repo = join(__dirname, '../../../../../..')
const catalog = JSON.parse(readFileSync(join(repo, 'frontend/schema/events.json'), 'utf8')) as {
  name: string
  fields?: { name: string; options?: string[] }[]
}[]
const options = (event: string, field: string): string[] | undefined =>
  catalog.find((entry) => entry.name === event)?.fields?.find((entry) => entry.name === field)?.options

describe('motion gestures', () => {
  it("are the contract's: its directions and positions", () => {
    expect(motionDirections).toEqual(options('flick', 'direction'))
    expect(motionDirections).toEqual(options('tilt', 'direction'))
    expect(motionPositions).toEqual(options('orientation', 'position'))
    for (const event of ['flick', 'tilt', 'shake', 'orientation'] as const) {
      expect(contractEventSpecs[event].since).toBe(motionGesturesMinVersion)
    }
  })

  it('offers every flick and tilt, a shake and every position, each once', () => {
    const gestures = motionGestures()
    expect(gestures).toHaveLength(motionDirections.length * 2 + 1 + motionPositions.length)
    const values = gestures.map(frameGestureValue)
    expect(new Set(values).size).toBe(values.length)
    for (const gesture of gestures) {
      expect(parseFrameGestureValue(frameGestureValue(gesture))).toEqual(gesture)
      expect(gestureCanVoiceChat(gesture)).toBe(false)
      expect(bindingOfRule(bindingRule({ gesture, action: { kind: 'forward' } }))).toEqual({
        gesture,
        action: { kind: 'forward' },
      })
    }
    expect(gestures.map(frameGestureTitle)).toContain('Flick to the right')
    expect(gestures.map(frameGestureTitle)).toContain('Laid face down')
  })

  it('writes a flick as one direction, a shake with no match', () => {
    expect(bindingRule({ gesture: { event: 'flick', direction: 'right' }, action: { kind: 'forward' } })).toEqual({
      event: 'flick',
      match: { direction: 'right' },
      emit: 'forward',
      as: {},
    })
    expect(bindingRule({ gesture: { event: 'shake' }, action: { kind: 'sceneSwitcher' } })).toEqual({
      event: 'shake',
      emit: 'sceneSwitcher',
      as: {},
    })
    expect(
      bindingRule({ gesture: { event: 'orientation', position: 'faceDown' }, action: { kind: 'turnOff' } })
    ).toEqual({ event: 'orientation', match: { position: 'faceDown' }, emit: 'turnOff', as: {} })
  })

  it('takes no unknown value', () => {
    expect(parseFrameGestureValue(JSON.stringify({ event: 'flick', direction: 'sideways' }))).toBeNull()
    expect(parseFrameGestureValue(JSON.stringify({ event: 'wobble' }))).toBeNull()
    expect(parseFrameGestureValue(JSON.stringify({ event: 'shake', direction: 'left' }))).toBeNull()
  })

  it('offers the actions a key has, voice chat aside', () => {
    const kinds = frameActionKindsFor(
      { event: 'flick', direction: 'left' },
      { voiceChat: true, displayPower: true, sceneSwitcher: true, sceneSettings: true, backForward: true }
    )
    expect(kinds).toEqual(expect.arrayContaining(['back', 'forward', 'nextScene', 'turnOff', 'sceneSwitcher']))
    expect(kinds).not.toContain('voiceChat')
  })

  it('says a motion bound twice', () => {
    const gesture = { event: 'flick' as const, direction: 'right' }
    expect(
      bindingConflicts([
        { gesture, action: { kind: 'forward' } },
        { gesture, action: { kind: 'back' } },
      ])
    ).toEqual(['Flick to the right is bound twice; only the first binding counts'])
  })

  it('from the FrameOS that hears an accelerometer', () => {
    expect(frameSupportsMotionGestures('2026.11.16', true)).toBe(false)
    expect(frameSupportsMotionGestures(motionGesturesMinVersion, true)).toBe(true)
    expect(frameSupportsMotionGestures(null, false)).toBe(true)
    expect(frameSupportsMotionGestures(null, true)).toBe(false)
  })
})

describe("a scene's motion rows (Map buttons)", () => {
  it('are its motion bindings; every other rule is kept', () => {
    const flick: EventMapRule = { event: 'flick', match: { direction: 'right' }, emit: 'forward', as: {} }
    const remap: EventMapRule = { event: 'button', match: { label: 'UP', action: 'press' }, as: { label: 'A' } }
    const odd: EventMapRule = { event: 'flick', match: { direction: 'right', x: 1 }, emit: 'forward', as: {} }
    const { bindings, others } = sceneMotionBindings([remap, flick, odd])
    expect(bindings).toEqual([{ gesture: { event: 'flick', direction: 'right' }, action: { kind: 'forward' } }])
    expect(others).toEqual([remap, odd])
  })

  it("leave a key's binding to the dialog's own rows", () => {
    const key: EventMapRule = {
      event: 'button',
      match: { label: 'UP', action: 'longPress' },
      emit: 'setCurrentScene',
      as: { direction: 'next' },
    }
    expect(sceneMotionBindings([key]).others).toEqual([key])
  })
})

describe('frameHasAccelerometer', () => {
  it("believes the board's report first", () => {
    expect(frameHasAccelerometer({ hardware: { imu: true } })).toBe(true)
    expect(frameHasAccelerometer({ hardware: { imu: false, hardwarePreset: 'seeed_reterminal_sticky' } })).toBe(false)
  })

  it('else goes by the preset', () => {
    for (const preset of ACCELEROMETER_HARDWARE_PRESETS) {
      expect(frameHasAccelerometer({ embedded: { hardwarePreset: preset } })).toBe(true)
      expect(frameHasAccelerometer({ device_config: { hardwarePreset: preset } })).toBe(true)
    }
    expect(frameHasAccelerometer({ embedded: { hardwarePreset: 'seeed_reterminal_e1002' } })).toBe(false)
    expect(frameHasAccelerometer(null)).toBe(false)
  })

  it('names presets the backend knows', () => {
    const firmware = readFileSync(join(repo, 'backend/app/tasks/embedded_firmware.py'), 'utf8')
    for (const preset of ACCELEROMETER_HARDWARE_PRESETS) {
      expect(firmware).toContain(`"${preset}": {`)
    }
  })
})
