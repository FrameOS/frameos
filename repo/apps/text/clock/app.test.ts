import { formatTime, get } from './app'

// Tuesday 12 March 2024, 14:40:37 in the zone the test runs in.
const at = new Date(2024, 2, 12, 14, 40, 37)

function clock(config: Record<string, unknown>, frame: Record<string, unknown> = {}) {
  const real = Date.now
  Date.now = () => at.getTime()
  try {
    return get(makeApp({ config, frame }))
  } finally {
    Date.now = real
  }
}

describe('clock', () => {
  it('shows its presets', () => {
    expect(clock({ format: '{hour/2}:{minute/2}' })).toBe('14:40')
    expect(clock({ format: '{hour/2}:{minute/2}:{second/2}' })).toBe('14:40:37')
    expect(clock({ format: '{hour/ap}:{minute/2} {am/pm}' })).toBe('2:40 pm')
    expect(clock({ format: '{year/4}-{month/2}-{day/2}' })).toBe('2024-03-12')
    expect(clock({ format: '{weekday} {day} {month/n} {year/4}' })).toBe('Tuesday 12 March 2024')
  })

  it('takes a custom format, the frame\'s zone by name, and leaves the rest as written', () => {
    expect(clock({ format: 'custom', formatCustom: '{weekday/3} {day/2}.{month/2} {tzName} {nope}' },
      { timeZone: 'Europe/Brussels' })).toBe('Tue 12.03 Europe/Brussels {nope}')
  })

  it('writes every chrono token', () => {
    const early = new Date(2009, 0, 5, 0, 7, 3)
    expect(formatTime(early, '{year} {year/2} {month} {month/n/3} {day} {weekday/2}')).toBe('2009 09 1 Jan 5 Mo')
    expect(formatTime(early, '{hour} {hour/2/ap} {am/pm} {minute} {second}')).toBe('0 12 am 7 3')
  })
})
