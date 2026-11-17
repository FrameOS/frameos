import { formatStdTimes, get } from './app'

// Tuesday 12 March 2024, 14:40:37.123 in the zone the test runs in: the
// expected strings are what std/times printed for the same fields.
const at = new Date(2024, 2, 12, 14, 40, 37, 123)

function clock(config: Record<string, unknown>, when = at) {
  const real = Date.now
  Date.now = () => when.getTime()
  try {
    return get(makeApp({ config }))
  } finally {
    Date.now = real
  }
}

describe('clockStdTimes', () => {
  it('shows the built-in clock\'s presets as std/times did', () => {
    expect(clock({ format: 'HH:mm:ss' })).toBe('14:40:37')
    expect(clock({ format: 'HH:mm' })).toBe('14:40')
    expect(clock({ format: 'yyyy-MM-dd' })).toBe('2024-03-12')
    expect(clock({ format: 'yyyy-MM-dd HH:mm:ss' })).toBe('2024-03-12 14:40:37')
    expect(clock({ format: 'HH:mm:ss:fff' })).toBe('14:40:37:123')
  })

  it('takes a custom format, and nothing when it is empty', () => {
    expect(clock({ format: 'custom', formatCustom: 'dddd d MMMM yyyy' })).toBe('Tuesday 12 March 2024')
    expect(clock({ format: 'custom', formatCustom: '' })).toBe('')
  })

  it('writes the tokens std/times writes', () => {
    expect(formatStdTimes(at, 'ddd, d MMM yy')).toBe('Tue, 12 Mar 24')
    expect(formatStdTimes(at, 'h:mm tt')).toBe('2:40 PM')
    expect(formatStdTimes(at, 'hh:mm t')).toBe('02:40 P')
    expect(formatStdTimes(at, 'H:m:s')).toBe('14:40:37')
    expect(formatStdTimes(at, 'M/d/yy')).toBe('3/12/24')
    expect(formatStdTimes(at, "'Week of' MMM d")).toBe('Week of Mar 12')
    expect(formatStdTimes(at, "HH'h'mm")).toBe('14h40')
    expect(formatStdTimes(at, "HH''mm")).toBe("14'40")
    expect(formatStdTimes(at, 'ss.ffffff')).toBe('37.123000')
    expect(formatStdTimes(at, 'YYYY uuuu g')).toBe('2024 2024 AD')
    expect(formatStdTimes(at, 'V VV GGGG')).toBe('11 11 2024')
    expect(formatStdTimes(new Date(2024, 2, 12, 0, 5), 'h hh tt')).toBe('12 12 AM')
    expect(formatStdTimes(new Date(2024, 2, 12, 12, 5), 'h tt')).toBe('12 PM')
  })

  it('refuses what std/times refused', () => {
    expect(() => formatStdTimes(at, 'yyyy-MM-ddTHH')).toThrow("'T' is not a valid pattern")
    expect(() => formatStdTimes(at, "HH 'oops")).toThrow('Unclosed')
  })
})
