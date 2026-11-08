import { get, groupEvents } from './app'

const draw = (config: Record<string, unknown>, size = { width: 800, height: 480 }) => {
  const app = makeApp({ config, frame: size })
  return get(app, makeContext()) as { svg: string; width: number; height: number }
}

// The clock at noon UTC on `day` for the length of `run`.
function onDay<T>(day: string, run: () => T): T {
  const real = Date.now
  Date.now = () => Date.parse(`${day}T12:00:00Z`)
  try {
    return run()
  } finally {
    Date.now = real
  }
}

const lines = (byDay: Record<string, { display: string }[]>, day: string) => (byDay[day] || []).map((l) => l.display)

describe('calendar', () => {
  it('puts all-day events first, then timed ones by start, an unreadable time last', () => {
    const byDay = groupEvents([
      { summary: 'All Day', startTime: '2026-03-05', allDay: true },
      { summary: 'Standup', startTime: '2026-03-05T09:00:00' },
      { summary: 'Breakfast', startTime: '2026-03-05T08:30:00' },
      { summary: 'Malformed Time', startTime: '2026-03-05Tbad' },
    ])
    expect(lines(byDay, '2026-03-05')).toEqual(['All Day', '08:30 Breakfast', '09:00 Standup', 'Malformed Time'])
    expect(lines(groupEvents([{ summary: 'Standup', startTime: '2026-03-05T09:00:00' }], { showEventTimes: false }), '2026-03-05')).toEqual([
      'Standup',
    ])
  })

  it('spreads an all-day event over every day to its end, and reads every all-day spelling', () => {
    const byDay = groupEvents(JSON.stringify([{ summary: 'Trip', startTime: '2026-03-10', endTime: '2026-03-12', all_day: 'yes' }]))
    expect(Object.keys(byDay).sort()).toEqual(['2026-03-10', '2026-03-11', '2026-03-12'])
    const across = groupEvents([{ summary: 'NYE', startTime: '2026-12-31', endTime: '2027-01-01' }])
    expect(Object.keys(across).sort()).toEqual(['2026-12-31', '2027-01-01'])
    // A midnight start counts as all day; a timed event stays on its first day.
    expect(groupEvents([{ summary: 'M', startTime: '2026-03-05T00:00:00', endTime: '2026-03-06T00:00:00' }])['2026-03-06']).toHaveLength(1)
    expect(groupEvents([{ summary: 'T', startTime: '2026-03-05T10:00:00', endTime: '2026-03-06T11:00:00' }])['2026-03-06']).toBeUndefined()
  })

  it('skips what it cannot place', () => {
    expect(groupEvents({ summary: 'not an array' })).toEqual({})
    expect(groupEvents('not json')).toEqual({})
    expect(groupEvents([{ summary: 'Bad', startTime: 'invalid' }])).toEqual({})
    const reversed = groupEvents([{ summary: 'Reverse', startTime: '2026-03-20', endTime: '2026-03-19', allDay: true }])
    expect(Object.keys(reversed)).toEqual(['2026-03-20'])
  })

  it('picks a chip colour from the title, inside the colours a custom theme gives', () => {
    const custom = { theme: 'custom', backgroundColor: '#abcdef', eventTitleColor: '#010203' }
    const colors = (config: Record<string, unknown>, title: string) =>
      groupEvents([{ summary: title, startTime: '2026-03-05' }], { ...custom, ...config })['2026-03-05'][0].colors
    expect(colors({ eventColorCount: 1, 'eventColorBackground[1]': '#112233', 'eventColorForeground[1]': '#ffffff' }, 'Standup')).toEqual([
      '#112233',
      '#ffffff',
    ])
    // Zero or negative: the theme's own colours.
    expect(colors({ eventColorCount: 0 }, 'Standup')).toEqual(['#abcdef', '#010203'])
    expect(colors({ eventColorCount: -3 }, 'Standup')).toEqual(['#abcdef', '#010203'])
    // The built-in app's hash: the same title, the same one of the light theme's seven.
    expect(colors({ theme: 'light' }, 'Conference')).toEqual(['#edc48a', '#000000'])
    expect(colors({ theme: 'light' }, 'Birthday')).toEqual(['#e6b5ff', '#000000'])
  })

  it('draws the month the size of the area it feeds', () => {
    const image = draw({ year: 2024, month: 3, events: [] })
    expect(image).toMatchObject({ __frameosType: 'image', width: 800, height: 480 })
    expect(image.svg).toContain('viewBox="0 0 800 480"')
    expect(image.svg).toContain('>March 2024</tspan>')
    expect(image.svg).toContain('>31</tspan>')
    expect(image.svg).not.toContain('>32</tspan>')
    expect(image.svg.indexOf('>Mon<')).toBeLessThan(image.svg.indexOf('>Sun<'))
    const sundayFirst = draw({ year: 2024, month: 3, startWeekOnMonday: false })
    expect(sundayFirst.svg.indexOf('>Sun<')).toBeLessThan(sundayFirst.svg.indexOf('>Mon<'))
  })

  it('shades weekends in the dark theme and, as the built-in app did, not in the light one', () => {
    expect(draw({ year: 2024, month: 3, theme: 'dark' }).svg).toContain('fill="#2d2d2d"')
    expect(draw({ year: 2024, month: 3, theme: 'light' }).svg).not.toContain('#aebee8')
  })

  it("boxes today's cell in this month and no other", () => {
    const today = onDay('2024-03-12', () => draw({ year: 0, month: 0, theme: 'light' }))
    expect(today.svg).toContain('>March 2024</tspan>')
    expect(today.svg).toContain('fill="#efbdbd"')
    expect(today.svg.match(/fill="#ff0000"/g)).toHaveLength(4)
    const other = onDay('2024-04-12', () => draw({ year: 2024, month: 3, theme: 'light' }))
    expect(other.svg).not.toContain('fill="#ff0000"')
  })

  it('cuts long titles, keeps the time apart, and counts what does not fit', () => {
    const events = [
      { summary: 'A very long event title indeed', startTime: '2024-03-12T08:00:00' },
      ...['Two', 'Three', 'Four', 'Five', 'Six', 'Seven'].map((summary, i) => ({ summary, startTime: `2024-03-12T1${i}:00:00` })),
    ]
    const svg = draw({ year: 2024, month: 3, events }).svg
    expect(svg).toContain('>08:00 </tspan><tspan font-family="Ubuntu-Medium.ttf" font-size="14" fill="#000000">A very…</tspan>')
    expect(svg).toMatch(/>\+\d more<\/tspan>/)
  })

  it('escapes titles, and leaves the background out when asked', () => {
    const svg = draw({ year: 2024, month: 3, events: [{ summary: 'R&D <x>', startTime: '2024-03-04' }], transparentBackground: true }).svg
    expect(svg).toContain('>R&amp;D &lt;x&gt;</tspan>')
    expect(svg).not.toContain('<rect width="800" height="480"')
  })

  it('needs a canvas to size itself to', () => {
    const app = makeApp({ config: {} })
    expect(() => get(app, { ...makeContext(), imageWidth: 0, imageHeight: 0, targetWidth: 0, targetHeight: 0 })).toThrow('No canvas')
  })
})
