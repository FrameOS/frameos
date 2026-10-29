import { get } from './app'

const config = {
  baseFontSize: 24,
  titleFontSize: 48,
  textColor: '#445566',
  timeColor: '#778899',
  titleColor: '#112233',
  startWithToday: false,
}

function agenda(events: unknown, extra: Record<string, unknown> = {}, timeZone = 'UTC') {
  return get(makeApp({ config: { ...config, ...extra, events }, frame: { timeZone } })) as string
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

describe('eventsToAgenda', () => {
  it('formats and sorts events across days', () => {
    const output = agenda([
      { summary: 'Holiday', startTime: '2024-12-25', endTime: '2024-12-25' },
      { summary: 'Breakfast', startTime: '2024-12-24T08:00:00', endTime: '2024-12-24T09:00:00' },
    ])
    expect(output).toBe(
      '\n^(48,#112233)Tuesday, December 24\n^(24,#445566)\n' +
        '^(24,#778899)08:00 - 09:00  ^(24,#445566)Breakfast\n' +
        '\n^(48,#112233)Wednesday, December 25\n^(24,#445566)\n' +
        '^(24,#778899)All day  ^(24,#445566)Holiday\n',
    )
  })

  it('shows until text for multi-day events', () => {
    const output = agenda([{ summary: 'Conference', startTime: '2024-12-25', endTime: '2024-12-27' }])
    expect(output).toContain('^(48,#112233)Wednesday, December 25')
    expect(output).toContain('^(24,#778899)Until Friday, December 27  ^(24,#445566)Conference')
  })

  it('shows an ongoing multi-day event under today when starting with today', () => {
    const output = onDay('2024-12-26', () =>
      agenda([{ summary: 'Retreat', startTime: '2024-12-23', endTime: '2024-12-27' }], { startWithToday: true }),
    )
    expect(output).not.toContain('No events today')
    expect(output.split('^(48,#112233)Thursday, December 26').length).toBe(2)
    expect(output).toContain('^(24,#778899)Until Friday, December 27  ^(24,#445566)Retreat')
  })

  it('says when today has nothing before the days that do', () => {
    const output = onDay('2024-12-26', () =>
      agenda([{ summary: 'Dinner', startTime: '2024-12-28T19:00:00', endTime: '2024-12-28T21:00:00' }], {
        startWithToday: true,
      }),
    )
    expect(output).toBe(
      '^(48,#112233)Thursday, December 26\n^(24,#445566)\nNo events today\n' +
        '\n^(48,#112233)Saturday, December 28\n^(24,#445566)\n' +
        '^(24,#778899)19:00 - 21:00  ^(24,#445566)Dinner\n',
    )
  })

  it('titles today over "No events found" without events', () => {
    for (const events of [[], null, undefined, 'nope']) {
      expect(onDay('2024-12-26', () => agenda(events))).toBe(
        '^(48,#112233)Thursday, December 26\n^(24,#445566)\nNo events found\n',
      )
    }
  })

  it('writes a font size without trailing zeros', () => {
    const output = agenda([{ summary: 'A', startTime: '2024-12-25', endTime: '2024-12-25' }], {
      baseFontSize: 24.5,
      titleFontSize: 0.1 + 0.2,
    })
    expect(output).toContain('^(0.3,#112233)Wednesday, December 25')
    expect(output).toContain('^(24.5,#778899)All day')
  })

  it('fails the node on a date it cannot read', () => {
    expect(() => agenda([{ summary: 'A', startTime: 'soon', endTime: 'later' }])).toThrow('Invalid date: soon')
  })
})
